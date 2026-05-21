import { ipcMain } from 'electron'
import {
  analyzeYouTube,
  saveAudioFile,
  readAudioFile,
} from '../services/music.service'
import { sanitizeString } from '../utils/security'

/** Music IPC — exposes :
 *   • analyzeYouTube → YouTube oEmbed metadata for the "Analyser" button
 *   • uploadAudio    → persist a user-uploaded ≤5 Mo audio blob
 *   • loadAudio      → read a stored audio file back as raw bytes for
 *                      <audio> playback in the renderer
 *  All three are scoped to Settings → Personnalisation → Musique de profil. */
export function registerMusicIpc(): void {
  ipcMain.handle('music:analyzeYouTube', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false as const, error: 'URL requise' }
    }
    try {
      const meta = await analyzeYouTube(url.trim())
      return { ok: true as const, meta }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'music:uploadAudio',
    async (_e, userId: unknown, mimeType: unknown, data: unknown) => {
      if (typeof userId !== 'string') return { ok: false as const, error: 'userId requis' }
      if (typeof mimeType !== 'string') return { ok: false as const, error: 'mimeType requis' }
      // IPC structured clone passes Uint8Array through directly. ArrayBuffer
      // also valid — wrap in case the renderer sent the underlying buffer.
      let bytes: Uint8Array
      if (data instanceof Uint8Array) bytes = data
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
      else return { ok: false as const, error: 'Données audio invalides' }

      try {
        const { relativePath } = await saveAudioFile(
          sanitizeString(userId, 64),
          mimeType,
          bytes,
        )
        return { ok: true as const, relativePath }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    },
  )

  ipcMain.handle('music:loadAudio', async (_e, relativePath: unknown) => {
    if (typeof relativePath !== 'string' || !relativePath) {
      return { ok: false as const, error: 'chemin requis' }
    }
    try {
      const bytes = await readAudioFile(relativePath)
      return { ok: true as const, bytes }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
}
