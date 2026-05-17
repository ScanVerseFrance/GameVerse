import { z } from 'zod'

export const addonManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9.\-_]+$/i, 'id must be alphanumeric (with . - _)'),
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  contentType: z.literal('games'),
  endpoints: z.object({
    catalog: z.string().min(1).max(500),
    meta: z.string().min(1).max(500).optional(),
    download: z.string().min(1).max(500).optional(),
    search: z.string().min(1).max(500).optional(),
    featured: z.string().min(1).max(500).optional(),
  }),
  catalogs: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(64),
        genres: z.array(z.string().max(64)).max(64).optional(),
        sortable: z.boolean().optional(),
      })
    )
    .min(1)
    .max(32),
  description: z.string().max(500).optional(),
  author: z.string().max(64).optional(),
  homepage: z.string().url().max(500).optional(),
  iconUrl: z.string().url().max(500).optional(),
  cacheTtlSeconds: z.number().int().min(0).max(86400).default(3600),
})

export type AddonManifest = z.infer<typeof addonManifestSchema>

export const gameSummarySchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  coverUrl: z.string().url().max(1000).optional(),
  releaseYear: z.number().int().min(1900).max(3000).optional(),
  genres: z.array(z.string().max(64)).max(32).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  rating: z.number().min(0).max(5).optional(),
})

export type GameSummary = z.infer<typeof gameSummarySchema>

export const gameDetailSchema = gameSummarySchema.extend({
  description: z.string().max(8000).optional(),
  developer: z.string().max(128).optional(),
  publisher: z.string().max(128).optional(),
  releaseDate: z.string().max(64).optional(),
  heroUrl: z.string().url().max(1000).optional(),
  screenshotUrls: z.array(z.string().url().max(1000)).max(20).optional(),
  videoUrls: z.array(z.string().url().max(1000)).max(10).optional(),
  systemRequirements: z
    .object({
      min: z.record(z.string().max(256)).optional(),
      recommended: z.record(z.string().max(256)).optional(),
    })
    .optional(),
  similarIds: z.array(z.string().max(256)).max(32).optional(),
})

export type GameDetail = z.infer<typeof gameDetailSchema>

export const downloadSourceSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['http', 'magnet', 'torrent-file']),
  url: z.string().min(1).max(4000),
  label: z.string().min(1).max(128),
  sizeBytes: z.number().int().min(0).optional(),
  language: z.string().max(16).optional(),
  uploader: z.string().max(128).optional(),
})

export type DownloadSource = z.infer<typeof downloadSourceSchema>

export const catalogResponseSchema = z.object({
  games: z.array(gameSummarySchema).max(200),
  total: z.number().int().min(0).optional(),
  page: z.number().int().min(0).optional(),
  hasMore: z.boolean().optional(),
})

export type CatalogResponse = z.infer<typeof catalogResponseSchema>

export const featuredResponseSchema = z.object({
  games: z.array(gameSummarySchema).max(100),
})

export type FeaturedResponse = z.infer<typeof featuredResponseSchema>

export const downloadResponseSchema = z.object({
  sources: z.array(downloadSourceSchema).max(50),
})

export type DownloadResponse = z.infer<typeof downloadResponseSchema>

export interface InstalledAddon {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  iconUrl: string | null
  manifestUrl: string
  manifest: AddonManifest
  enabled: boolean
  trusted: boolean
  installedAt: number
  updatedAt: number
}

export interface CatalogQuery {
  catalogId?: string
  genre?: string
  page?: number
  pageSize?: number
  sort?: string
}

export interface AddonGame extends GameSummary {
  addonId: string
  addonName: string
}
