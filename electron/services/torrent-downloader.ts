// webtorrent v2 is ESM-only and cannot be `require()`d from our CJS main bundle.
// Use a dynamic `import()` instead — Node supports loading ESM from CJS that way.
// Types are kept inline so a webtorrent .d.ts drift can't break the build.

interface TorrentInfo {
  downloaded: number
  length: number
  downloadSpeed: number
  numPeers: number
  ratio: number
  uploaded: number
  infoHash: string
  /** Torrent display name — equals the folder webtorrent creates inside `path`
   * (or the file name for single-file torrents). Available after metadata. */
  name?: string
  /** Absolute path to the torrent root on disk — what we use as install path
   * for library entries. Set after `'ready'`. */
  path?: string
  destroyed?: boolean
  on(event: string, cb: (...args: unknown[]) => void): void
  off?(event: string, cb: (...args: unknown[]) => void): void
  removeAllListeners?(event?: string): void
}

interface WebTorrentClient {
  add(torrentId: string, opts: { path: string }): TorrentInfo
  remove(
    torrentId: string,
    opts?: { destroyStore?: boolean },
    cb?: (err?: Error | null) => void
  ): void
  get(torrentId: string): TorrentInfo | null | undefined
  throttleDownload(bps: number): void
  on(event: string, cb: (...args: unknown[]) => void): void
}

export interface TorrentHandle {
  pause: () => void
  destroy: (deleteFiles: boolean) => void
}

interface StartParams {
  magnetOrUrl: string
  targetFolder: string
  seedRatio: number
  onProgress: (downloaded: number, total: number, speed: number, peers: number, ratio: number) => void
  /** installPath = actual folder where the torrent data was written. Equals
   * `${targetFolder}/${torrent.name}` for normal multi-file torrents, or the
   * file path for single-file torrents. Empty string when unknown. */
  onComplete: (installPath: string) => void
  onSeedComplete: () => void
  onError: (msg: string) => void
}

let clientPromise: Promise<WebTorrentClient> | null = null

function getClient(): Promise<WebTorrentClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = (await import('webtorrent')) as unknown as {
        default?: new () => WebTorrentClient
      }
      const Ctor = mod.default ?? (mod as unknown as new () => WebTorrentClient)
      const client = new Ctor()
      // Critical safety net: WebTorrent's client extends EventEmitter, and it
      // re-emits errors from torrents that no longer have their own listener
      // attached (typical after we `remove()` a torrent that is mid-handshake).
      // Without this catch-all, an async tracker/wire error after pause/cancel
      // becomes an uncaughtException and crashes the entire Electron main
      // process — exactly the "j'arrête le téléchargement et l'app crash" symptom.
      client.on('error', (err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[webtorrent client] swallowed error:', err)
      })
      return client
    })()
  }
  return clientPromise
}

export function setGlobalThrottle(bps: number): void {
  if (!clientPromise && bps <= 0) return
  void getClient().then((c) => {
    c.throttleDownload(bps > 0 ? bps : -1)
  })
}

/**
 * Best-effort remove that absorbs every possible failure mode:
 *  - sync throw (e.g. torrent not registered)
 *  - async callback error
 *  - 'error' event emitted on client AFTER remove resolves
 * Returns a promise that resolves once we've done our part — never rejects.
 */
function safeRemove(
  client: WebTorrentClient,
  infoHash: string,
  destroyStore: boolean
): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Some versions throw if the torrent is already gone — check first.
      const existing = typeof client.get === 'function' ? client.get(infoHash) : null
      if (!existing) {
        resolve()
        return
      }
      client.remove(infoHash, { destroyStore }, (err) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.warn('[webtorrent remove] callback err:', err.message)
        }
        resolve()
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[webtorrent remove] sync throw:', (e as Error).message)
      resolve()
    }
  })
}

export function startTorrentDownload(params: StartParams): TorrentHandle {
  let torrent: TorrentInfo | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let clientRef: WebTorrentClient | null = null
  let done = false
  let seedingStopped = false
  // Lifecycle flag — once true, we ignore every subsequent torrent event
  // (errors, ready, done) so a fired-after-stop event can't write to the
  // already-finalized download row or call user callbacks twice.
  let stopped = false
  // Set immediately by destroy() so the async client-acquire bailout knows
  // not to bother adding the torrent at all.
  let destroyedEarly = false

  function clearTicker(): void {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  function detachTorrentListeners(): void {
    if (!torrent) return
    try {
      torrent.removeAllListeners?.('error')
      torrent.removeAllListeners?.('ready')
      torrent.removeAllListeners?.('done')
    } catch {
      // ignore
    }
  }

  async function stopSeeding(): Promise<void> {
    if (seedingStopped) return
    seedingStopped = true
    clearTicker()
    if (clientRef && torrent) {
      await safeRemove(clientRef, torrent.infoHash, false)
    }
    if (!stopped) params.onSeedComplete()
  }

  void (async () => {
    try {
      clientRef = await getClient()
    } catch (err) {
      params.onError((err as Error).message)
      return
    }
    if (destroyedEarly) return

    try {
      torrent = clientRef.add(params.magnetOrUrl, { path: params.targetFolder })
    } catch (err) {
      params.onError((err as Error).message)
      return
    }

    torrent.on('error', (err: unknown) => {
      if (stopped) return
      clearTicker()
      const msg = err instanceof Error ? err.message : String(err)
      params.onError(msg)
    })

    torrent.on('ready', () => {
      if (stopped) return
      interval = setInterval(() => {
        if (stopped || !torrent) return
        try {
          params.onProgress(
            torrent.downloaded,
            torrent.length,
            torrent.downloadSpeed,
            torrent.numPeers,
            torrent.ratio
          )
        } catch {
          // ignore — progress callback shouldn't be able to kill the loop
        }
        if (done && !seedingStopped && torrent.ratio >= params.seedRatio) {
          void stopSeeding()
        }
      }, 500)
    })

    torrent.on('done', () => {
      if (stopped) return
      done = true
      if (torrent) {
        params.onProgress(torrent.length, torrent.length, 0, torrent.numPeers, torrent.ratio)
      }
      // installPath = the actual folder webtorrent wrote into. Falls back to
      // the parent targetFolder if `name` isn't populated (single-file torrent
      // without metadata or some webtorrent version edge case).
      const installPath = torrent?.name
        ? `${params.targetFolder.replace(/[\\/]+$/, '')}/${torrent.name}`.replace(/\\/g, '/')
        : params.targetFolder
      params.onComplete(installPath)
      if (params.seedRatio <= 0 || (torrent && torrent.ratio >= params.seedRatio)) {
        void stopSeeding()
      }
    })
  })()

  return {
    pause: () => {
      if (stopped) return
      stopped = true
      clearTicker()
      detachTorrentListeners()
      const t = torrent
      torrent = null
      if (clientRef && t) {
        void safeRemove(clientRef, t.infoHash, false)
      }
    },
    destroy: (deleteFiles: boolean) => {
      if (stopped) {
        // Late-cancel: client/torrent may already be torn down, but the user
        // requested deleteFiles=true — try one more safe-remove with destroyStore.
        if (deleteFiles && clientRef && torrent) {
          void safeRemove(clientRef, torrent.infoHash, true)
        }
        return
      }
      stopped = true
      destroyedEarly = true
      clearTicker()
      detachTorrentListeners()
      const t = torrent
      torrent = null
      if (clientRef && t) {
        void safeRemove(clientRef, t.infoHash, deleteFiles)
      }
    },
  }
}
