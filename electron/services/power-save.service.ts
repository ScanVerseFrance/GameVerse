/**
 * Power Save Blocker — keeps Windows / macOS awake while downloads
 * are running. Mirrors Hydra's power-save-blocker.ts behaviour:
 *
 *   • One acquisition per active download (reference-counted)
 *   • `prevent-app-suspension` mode: app keeps running in background
 *     but the display CAN sleep (we don't want to be that app that
 *     wakes the screen at 3 AM during a 50 GB FitGirl extraction)
 *   • Released when the last download finishes / errors / is paused
 *
 * Electron's powerSaveBlocker uses an integer handle per call. We
 * stash them in a Map keyed by download id so each acquire is paired
 * with exactly one release — no stuck acquisitions if a download
 * status fires twice. The Map also keeps cardinality query cheap.
 */
import { powerSaveBlocker } from 'electron'
import { debugLog } from './debug-log.service'

const blockerHandles = new Map<string, number>()

/**
 * Acquire a power-save blocker for this download id. Idempotent — a
 * second acquire for the same id is a no-op (returns the existing
 * handle). The lifecycle hook in download.service.ts calls this when
 * a row transitions to 'queued' / 'downloading'.
 */
export function acquireForDownload(downloadId: string): void {
  if (blockerHandles.has(downloadId)) return
  try {
    const id = powerSaveBlocker.start('prevent-app-suspension')
    blockerHandles.set(downloadId, id)
    debugLog('power-save', 'acquired', {
      downloadId,
      handle: id,
      activeCount: blockerHandles.size,
    })
  } catch (err) {
    // powerSaveBlocker can theoretically fail on some Linux configs.
    // We swallow + log — the download still proceeds, the OS might
    // just sleep mid-transfer.
    debugLog('power-save', 'acquire failed', {
      downloadId,
      error: (err as Error).message,
    })
  }
}

/**
 * Release the blocker for this download id. Idempotent — release on
 * an unknown id is a no-op. Called when a download transitions to
 * 'completed' / 'error' / 'paused' / 'cancelled', AND on app
 * shutdown via releaseAll().
 */
export function releaseForDownload(downloadId: string): void {
  const handle = blockerHandles.get(downloadId)
  if (handle == null) return
  try {
    powerSaveBlocker.stop(handle)
  } catch (err) {
    debugLog('power-save', 'release failed', {
      downloadId,
      error: (err as Error).message,
    })
  } finally {
    blockerHandles.delete(downloadId)
    debugLog('power-save', 'released', {
      downloadId,
      activeCount: blockerHandles.size,
    })
  }
}

/**
 * Drop every outstanding blocker. Called from shutdownDownloads /
 * app `before-quit` so we don't leak handles into Windows' power
 * state when the user kills the launcher mid-download.
 */
export function releaseAll(): void {
  for (const [id, handle] of blockerHandles) {
    try {
      powerSaveBlocker.stop(handle)
    } catch {
      /* ignore — we're shutting down */
    }
    blockerHandles.delete(id)
  }
}

/** Diagnostic — number of outstanding acquisitions. Surfaced via the
 *  IPC `system:diag` so the status bar can show "🔒 X downloads
 *  keeping the PC awake" if we want it later. */
export function activeBlockerCount(): number {
  return blockerHandles.size
}
