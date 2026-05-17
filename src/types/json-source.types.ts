import { z } from 'zod'

/**
 * Hydra-style static source file. Compatible with `.json` catalogs shared in
 * the community: a top-level `{ name, downloads: [...] }` with one entry per
 * release. We don't care about the source's politics — Nexus is plugin-neutral,
 * the user authors / curates / installs whatever JSON they want.
 */
export const jsonSourceFileSchema = z.object({
  name: z.string().min(1).max(120),
  downloads: z
    .array(
      z.object({
        title: z.string().min(1).max(512),
        uris: z.array(z.string().min(1).max(8000)).min(1).max(64),
        uploadDate: z.string().max(64).optional(),
        fileSize: z.string().max(64).optional(),
      })
    )
    .min(0)
    .max(20000),
})

export type JsonSourceFile = z.infer<typeof jsonSourceFileSchema>

export interface JsonSourceRecord {
  id: string
  name: string
  originPath: string | null
  gameCount: number
  importedAt: number
  updatedAt: number
}

export interface JsonSourceGame {
  id: string
  sourceId: string
  title: string
  uploadDate: string | null
  fileSize: string | null
  uris: string[]
  addedAt: number
}

export interface ImportJsonSourceResult {
  ok: boolean
  error?: string
  source?: JsonSourceRecord
  gamesAdded?: number
  warnings?: string[]
}

/** Search hit — same as a game but with the parent source's name inlined
 * (saves a join round-trip on the renderer side). */
export interface JsonSourceSearchHit extends JsonSourceGame {
  sourceName: string
}
