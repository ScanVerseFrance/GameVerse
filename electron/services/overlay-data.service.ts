/**
 * Data helpers du panneau overlay : notes par jeu, screenshots,
 * snapshot perf. Stateless — appelés par overlay.ipc.
 *
 * Notes : table `game_notes` (created via ensureColumn / IF NOT EXISTS).
 *   Une seule note par (user_id, library_game_id). Le panel Notes
 *   appelle saveNote() en debounced 800ms.
 *
 * Screenshots : sauvegardés dans `%UserProfile%\Pictures\Nexus\<game>\`.
 *   La capture utilise desktopCapturer (qui retourne un dataURL PNG)
 *   converti en buffer puis écrit sur disque. listScreenshots() walk
 *   le dossier pour lister les .png.
 *
 * Perf : utilise systeminformation (déjà dans deps via electron) pour
 *   CPU, RAM, GPU, disque. Snapshot rapide (~50ms).
 */
import { app, desktopCapturer, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDatabase } from './database.service'

// ─────────────────────────── NOTES ────────────────────────────────

export function ensureNotesSchema(): void {
  try {
    getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS game_notes (
        user_id TEXT NOT NULL,
        library_game_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, library_game_id)
      );
    `)
  } catch {
    /* schema may not be ready yet — DB init runs first */
  }
}

export function getNote(
  userId: string,
  libraryGameId: string,
): { text: string; updatedAt: number } {
  try {
    const row = getDatabase()
      .prepare(
        'SELECT content, updated_at FROM game_notes WHERE user_id = ? AND library_game_id = ?',
      )
      .get(userId, libraryGameId) as
      | { content: string; updated_at: number }
      | undefined
    if (!row) return { text: '', updatedAt: 0 }
    return { text: row.content, updatedAt: row.updated_at }
  } catch {
    return { text: '', updatedAt: 0 }
  }
}

export function saveNote(
  userId: string,
  libraryGameId: string,
  content: string,
): boolean {
  try {
    getDatabase()
      .prepare(
        `INSERT INTO game_notes (user_id, library_game_id, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, library_game_id) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(userId, libraryGameId, content, Date.now())
    return true
  } catch (e) {
    console.warn('[overlay-data] saveNote failed:', (e as Error).message)
    return false
  }
}

// ──────────────────────── SCREENSHOTS ─────────────────────────────

function screenshotsDir(libraryGameId: string): string {
  const pictures = app.getPath('pictures') ?? path.join(os.homedir(), 'Pictures')
  // Sanitize libraryGameId (UUID-like donc safe en général) mais on
  // strip quand même tout caractère non-alphanum pour éviter les
  // traversals.
  const safe = libraryGameId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64)
  return path.join(pictures, 'Nexus', safe)
}

export async function captureScreenshot(
  libraryGameId: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const dir = screenshotsDir(libraryGameId)
    fs.mkdirSync(dir, { recursive: true })
    // Cible : l'écran primaire à sa résolution native. Si le jeu
    // tourne en fullscreen sur un autre monitor on capture quand
    // même le primaire (limitation acceptée du MVP).
    const primary = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: primary.size.width,
        height: primary.size.height,
      },
    })
    const src = sources[0]
    if (!src) {
      return { ok: false, error: 'Aucune source de capture disponible.' }
    }
    const pngBuffer = src.thumbnail.toPNG()
    const filename = `screenshot-${Date.now()}.png`
    const filePath = path.join(dir, filename)
    fs.writeFileSync(filePath, pngBuffer)
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function listScreenshots(libraryGameId: string): Array<{
  path: string
  url: string
  takenAt: number
}> {
  const dir = screenshotsDir(libraryGameId)
  try {
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f))
    return files
      .map((f) => {
        const p = path.join(dir, f)
        let takenAt = 0
        try {
          takenAt = fs.statSync(p).mtimeMs
        } catch {
          /* skip mtime */
        }
        return {
          path: p,
          // file:// URL pour rendu direct dans <img>. Electron
          // accepte le scheme dans la window overlay (webSecurity true
          // mais le fichier est local).
          url: `file://${p.replace(/\\/g, '/')}`,
          takenAt,
        }
      })
      .sort((a, b) => b.takenAt - a.takenAt)
  } catch {
    return []
  }
}

export function openScreenshotsFolder(libraryGameId: string): void {
  const dir = screenshotsDir(libraryGameId)
  try {
    fs.mkdirSync(dir, { recursive: true })
    void shell.openPath(dir).catch(() => {})
  } catch {
    /* skip */
  }
}

// ───────────────────────── PERF SNAPSHOT ──────────────────────────

let lastDiskIO: { readBytes: number; writeBytes: number; ts: number } | null =
  null

export async function getPerfSnapshot(): Promise<{
  cpu: { percent: number; cores: number; model: string }
  ram: { usedBytes: number; totalBytes: number; percent: number }
  gpu: { percent: number; memUsedMB: number; memTotalMB: number; model: string } | null
  disk: { readBps: number; writeBps: number }
  uptimeSeconds: number
}> {
  // Import paresseux pour ne pas grever le boot — systeminformation
  // est large + ses propres requires sont coûteux à warm.
  const si = await import('systeminformation')

  // CPU : currentLoad() retourne %use depuis le dernier appel ; le
  // premier appel est inutile (renvoie 0). On call 2x avec 100ms gap
  // pour avoir un vrai delta dès le 1er snapshot.
  await si.currentLoad()
  await new Promise((r) => setTimeout(r, 100))
  const cpuLoad = await si.currentLoad()
  const cpuInfo = await si.cpu()
  const mem = await si.mem()
  const gpus = await si.graphics()
  const diskIO = await si.disksIO()
  const time = await si.time()

  // Disk delta vs lastDiskIO pour calculer un bps réel.
  const now = Date.now()
  let readBps = 0
  let writeBps = 0
  if (lastDiskIO && now > lastDiskIO.ts) {
    const dt = (now - lastDiskIO.ts) / 1000
    if (dt > 0 && dt < 60) {
      // Sanity check : pas de delta sur un gap > 60s (probable
      // suspend/resume), on reset.
      readBps = Math.max(
        0,
        (diskIO.rIO_sec ?? 0) * 512, // rIO_sec is in sectors/s
      )
      writeBps = Math.max(
        0,
        (diskIO.wIO_sec ?? 0) * 512,
      )
    }
  }
  lastDiskIO = {
    readBytes: diskIO.rIO_sec ?? 0,
    writeBytes: diskIO.wIO_sec ?? 0,
    ts: now,
  }

  // GPU : prend le 1er GPU avec utilisation reportée. NVIDIA & AMD
  // exposent utilizationGpu via nvidia-smi / WMI ; Intel iGPU ne le
  // fait pas → null.
  const gpu = gpus.controllers.find(
    (g) => typeof g.utilizationGpu === 'number',
  )

  return {
    cpu: {
      percent: cpuLoad.currentLoad ?? 0,
      cores: cpuInfo.cores ?? 0,
      model: `${cpuInfo.manufacturer ?? ''} ${cpuInfo.brand ?? ''}`.trim(),
    },
    ram: {
      usedBytes: mem.active ?? mem.used ?? 0,
      totalBytes: mem.total ?? 0,
      percent: mem.total > 0 ? ((mem.active ?? mem.used) / mem.total) * 100 : 0,
    },
    gpu: gpu
      ? {
          percent: gpu.utilizationGpu ?? 0,
          memUsedMB: gpu.memoryUsed ?? 0,
          memTotalMB: gpu.memoryTotal ?? gpu.vram ?? 0,
          model: gpu.model ?? '',
        }
      : null,
    disk: { readBps, writeBps },
    uptimeSeconds: time.uptime ?? 0,
  }
}
