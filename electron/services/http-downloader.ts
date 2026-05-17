import fs from 'node:fs'
import path from 'node:path'

export interface HttpHandle {
  abort: (deleteFiles?: boolean) => void
}

interface StartParams {
  url: string
  targetFolder: string
  fileNameFallback: string
  resumeFrom?: number
  onProgress: (downloaded: number, total: number, speed: number) => void
  /** installPath = final absolute path of the written file (used as the
   * library install_path for HTTP downloads — the "folder" is just the file
   * itself in this case, but the auto-exe-detector handles both). */
  onComplete: (installPath: string) => void
  onError: (msg: string) => void
}

function deriveFilename(url: string, fallback: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last && /\.[a-zA-Z0-9]{1,8}$/.test(last)) {
      return decodeURIComponent(last)
    }
  } catch {
    // ignore
  }
  return fallback.replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 100) || 'download'
}

export function startHttpDownload(params: StartParams): HttpHandle {
  const ctrl = new AbortController()
  // We need the target path inside `abort()` to delete the partial file on
  // cancel. The path is decided inside `run()`, so stash it via a closure
  // ref the moment it's known. Empty string until then.
  const targetRef = { path: '' }
  void run(params, ctrl, targetRef).catch((err) => {
    if ((err as Error).name === 'AbortError') return
    params.onError((err as Error).message)
  })
  return {
    abort: (deleteFiles?: boolean) => {
      ctrl.abort()
      // Best-effort cleanup of the partial file. Wrapped in try because:
      //  - the path may not exist yet (aborted before fs.createWriteStream),
      //  - the stream may still hold the file handle for a few ms (Windows
      //    refuses unlink on locked files). We retry once on EBUSY.
      if (deleteFiles && targetRef.path) {
        const p = targetRef.path
        const tryUnlink = (attempts: number): void => {
          try {
            if (fs.existsSync(p)) fs.unlinkSync(p)
          } catch (e) {
            if (attempts > 0 && (e as NodeJS.ErrnoException).code === 'EBUSY') {
              setTimeout(() => tryUnlink(attempts - 1), 200)
            }
          }
        }
        tryUnlink(3)
      }
    },
  }
}

async function run(
  params: StartParams,
  ctrl: AbortController,
  targetRef: { path: string }
): Promise<void> {
  const filename = deriveFilename(params.url, params.fileNameFallback)
  const targetPath = path.join(params.targetFolder, filename)
  targetRef.path = targetPath
  await fs.promises.mkdir(params.targetFolder, { recursive: true })

  const headers: Record<string, string> = {}
  const resumeFrom = params.resumeFrom ?? 0
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

  const res = await fetch(params.url, { signal: ctrl.signal, headers })
  if (!res.ok && res.status !== 206) {
    params.onError(`HTTP ${res.status} ${res.statusText}`)
    return
  }
  const lengthHeader = res.headers.get('content-length')
  const partialTotal = lengthHeader ? parseInt(lengthHeader, 10) : 0
  const total = resumeFrom + (Number.isFinite(partialTotal) ? partialTotal : 0)

  const stream = fs.createWriteStream(targetPath, { flags: resumeFrom > 0 ? 'a' : 'w' })

  let downloaded = resumeFrom
  let lastTick = Date.now()
  let lastBytes = downloaded

  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    stream.write(buf)
    downloaded += buf.byteLength
    params.onProgress(downloaded, total || downloaded, 0)
    await new Promise<void>((resolve) => stream.end(() => resolve()))
    params.onComplete(targetPath)
    return
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const ok = stream.write(value)
        if (!ok) {
          await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
        }
        downloaded += value.byteLength
        const now = Date.now()
        if (now - lastTick >= 400) {
          const speed = ((downloaded - lastBytes) * 1000) / (now - lastTick)
          params.onProgress(downloaded, total || downloaded, speed)
          lastTick = now
          lastBytes = downloaded
        }
      }
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()))
    params.onProgress(downloaded, total || downloaded, 0)
    params.onComplete(targetPath)
  } catch (err) {
    stream.destroy()
    if ((err as Error).name !== 'AbortError') {
      params.onError((err as Error).message)
    }
  }
}
