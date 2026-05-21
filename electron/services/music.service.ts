/**
 * music.service — light-weight YouTube metadata extractor.
 *
 * No API key, no ytdl dependency, no audio download. We call YouTube's
 * own oEmbed endpoint (https://www.youtube.com/oembed?url=…&format=json)
 * which returns:
 *   - title           — used as track name
 *   - author_name     — used as artist
 *   - thumbnail_url   — used as album art
 *
 * Duration isn't in oEmbed; the renderer reads it once the IFrame
 * Player loads (MusicContext already does this for playback). Until
 * then the picker shows `—` and the clip slider stays at 0..300 s
 * (the 5-min ScanVerse default).
 *
 * We don't extract audio because :
 *   1. ytdl-core breaks every 2-3 months when YouTube tweaks its
 *      streaming map.
 *   2. Storage + streaming would balloon the launcher's installer.
 *   3. The IFrame Player handles playback fine and respects YouTube's
 *      ToS (no ad-skipping, etc.).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { safeFetchJson } from '../utils/http'

export interface YouTubeTrackMeta {
  videoId: string
  title: string
  author: string | null
  /** Best-effort thumbnail. We prefer maxresdefault (1280×720) but the
   *  uploader may not have provided one, in which case YouTube's CDN
   *  serves the next-best size automatically. */
  thumbnail: string
}

/** Parse all flavours of YouTube URL into a bare 11-char video id.
 *  Returns null for non-YouTube URLs — the caller surfaces a friendly
 *  "URL non reconnue" rather than throwing. Mirrors the renderer-side
 *  `extractYouTubeId` in MusicContext.tsx for parity. */
export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\/+/, '').split(/[/?#]/)[0]
      return id || null
    }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null
    const v = u.searchParams.get('v')
    if (v) return v
    const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)
    if (m) return m[1]
  } catch {
    /* not a URL */
  }
  return null
}

interface OEmbedResponse {
  title?: string
  author_name?: string
  thumbnail_url?: string
}

/** Fetch oEmbed metadata for a YouTube video. Throws on network / 404
 *  errors so the IPC layer can return a typed { ok: false, error }. */
export async function analyzeYouTube(url: string): Promise<YouTubeTrackMeta> {
  const videoId = extractYouTubeId(url)
  if (!videoId) throw new Error("URL YouTube non reconnue")

  // Canonical watch URL avoids oEmbed quirks with shorts / embed paths.
  const canonical = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`

  const raw = (await safeFetchJson(endpoint, { timeoutMs: 8_000 })) as OEmbedResponse
  if (!raw || typeof raw !== 'object') throw new Error('oEmbed: réponse invalide')

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Sans titre'
  const author = typeof raw.author_name === 'string' && raw.author_name.trim() ? raw.author_name.trim() : null
  // YouTube's static thumb CDN beats the oEmbed thumb (hqdefault) on
  // resolution. On utilise `maxresdefault.jpg` (1280×720, vrai 16:9
  // SANS bandes noires baked-in dans les pixels). `hqdefault.jpg` est
  // tentant pour sa garantie d'existence mais c'est un canvas 4:3
  // (480×360) avec l'image 16:9 letterboxée dedans — les bandes noires
  // top/bottom sont VRAIS pixels noirs, aucun `object-fit: cover` côté
  // frontend ne peut les retirer. Le fallback côté composants (MiniPlayer,
  // ExtendedPlayer, ProfileMusicPicker) bascule sur `mqdefault.jpg`
  // (320×180, aussi vraie 16:9 sans bandes) via `onError` si la vidéo
  // n'a pas de version maxres (uploads non-HD pré-2017).
  const thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`

  return { videoId, title, author, thumbnail }
}

/* ─────────── User-uploaded audio (5 MB max) ─────────── */

/** Hard cap on uploaded audio size — matches ScanVerse's 5 Mo policy.
 *  Anything bigger throws and the renderer surfaces a friendly error. */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024

/** Whitelist of accepted MIME prefixes. The renderer's <input type=file>
 *  also restricts via accept=, but we re-validate in main since the
 *  IPC boundary can't trust the renderer. */
const ALLOWED_AUDIO_MIME = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
] as const

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
}

function audioDir(): string {
  return path.join(app.getPath('userData'), 'profile-audio')
}

/** Resolve the absolute path of a stored audio file from its relative
 *  reference (`<userId>.<ext>`). Returns null if the file doesn't
 *  exist — callers should clean the DB pointer in that case. */
export function resolveAudioPath(relative: string): string | null {
  // Defence in depth — refuse anything with path separators so a
  // malicious DB row can't escape the audio dir.
  if (!relative || relative.includes('/') || relative.includes('\\') || relative.includes('..')) {
    return null
  }
  return path.join(audioDir(), relative)
}

/** Persist a user-uploaded audio blob under userData/profile-audio/.
 *  `mimeType` must be one of the whitelisted audio MIMEs; `data` is a
 *  Uint8Array (≤5 MB). Returns the relative filename to store in the
 *  DB (`profile_music_audio_path`). Overwrites any previous file for
 *  this user. */
export async function saveAudioFile(
  userId: string,
  mimeType: string,
  data: Uint8Array,
): Promise<{ relativePath: string; absolutePath: string }> {
  if (!userId || typeof userId !== 'string') throw new Error('userId requis')
  if (!ALLOWED_AUDIO_MIME.includes(mimeType as (typeof ALLOWED_AUDIO_MIME)[number])) {
    throw new Error('Format audio non supporté')
  }
  if (data.byteLength === 0) throw new Error('Fichier vide')
  if (data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Fichier trop volumineux (${(data.byteLength / 1024 / 1024).toFixed(1)} Mo, max 5 Mo)`,
    )
  }
  const ext = EXT_BY_MIME[mimeType] ?? 'bin'
  const safeUid = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  const filename = `${safeUid}.${ext}`
  const dir = audioDir()
  await fs.mkdir(dir, { recursive: true })

  // Wipe any previous audio file for this user — they're rotating to
  // a new clip and we don't want stale ext combinations (e.g. an old
  // .wav lingering after the user switches to .mp3) inflating
  // userData over time.
  try {
    const entries = await fs.readdir(dir)
    for (const e of entries) {
      if (e.startsWith(`${safeUid}.`) && e !== filename) {
        await fs.unlink(path.join(dir, e)).catch(() => undefined)
      }
    }
  } catch {
    /* dir was just created — nothing to clean */
  }

  const abs = path.join(dir, filename)
  await fs.writeFile(abs, data)
  return { relativePath: filename, absolutePath: abs }
}

/** Read a stored audio file back as raw bytes. Renderer wraps the
 *  Uint8Array in a Blob + ObjectURL for the <audio> element. */
export async function readAudioFile(relative: string): Promise<Uint8Array> {
  const abs = resolveAudioPath(relative)
  if (!abs) throw new Error('Chemin audio invalide')
  const buf = await fs.readFile(abs)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** Best-effort cleanup when the user removes their profile music.
 *  Silently swallows ENOENT — we never want delete to fail the wider
 *  cosmetics patch. */
export async function deleteAudioFile(relative: string | null): Promise<void> {
  if (!relative) return
  const abs = resolveAudioPath(relative)
  if (!abs) return
  await fs.unlink(abs).catch(() => undefined)
}
