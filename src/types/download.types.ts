export type DownloadKind = 'http' | 'magnet' | 'torrent-file'
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error'

export interface DownloadRecord {
  id: string
  userId: string
  gameTitle: string
  gameId: string | null
  addonId: string | null
  sourceUrl: string
  kind: DownloadKind
  magnetOrUrl: string
  targetFolder: string
  coverUrl: string | null
  totalBytes: number
  downloadedBytes: number
  status: DownloadStatus
  queuePosition: number
  createdAt: number
  finishedAt: number | null
  error: string | null
  speed: number
  eta: number
  peers: number | null
  ratio: number | null
  /** v0.5.1 — URL Online-Fix associée (l'user a coché "Inclure
   *  Online-Fix" au démarrage). Ouvre dans le navigateur quand le
   *  téléchargement principal se termine. */
  addonFixUrl: string | null
  addonFixLabel: string | null
}

export interface DownloadSettings {
  maxConcurrent: number
  bandwidthLimitBps: number
  seedRatio: number
  defaultTargetFolder: string
  notificationsEnabled: boolean
}

export interface NewDownloadParams {
  userId: string
  gameTitle: string
  gameId?: string
  addonId?: string
  sourceUrl: string
  kind: DownloadKind
  magnetOrUrl: string
  coverUrl?: string
  targetFolder?: string
  /** v0.5.1 — quand l'user a coché "Inclure Online-Fix" dans le
   *  dialog, on stocke l'URL du variant Online-Fix correspondant.
   *  À la fin du téléchargement principal le download.service ouvrira
   *  cette URL dans le navigateur + le dossier d'install dans
   *  l'explorateur pour que l'user merge le patch en glisser-déposer.
   *  Pourquoi pas auto-extract ? Online-Fix protège ses archives par
   *  mot de passe — pas d'auto-DL possible côté client.
   *
   *  `addonFixLabel` = "Online-Fix" (nom de la source) — sert juste à
   *  enrichir la toast finale ("Patch Online-Fix prêt"). */
  addonFixUrl?: string
  addonFixLabel?: string
}

export interface DownloadProgressEvent {
  id: string
  downloaded: number
  total: number
  speed: number
  eta: number
  peers: number | null
  ratio: number | null
}

export interface DownloadStateEvent {
  id: string
  status: DownloadStatus
  error: string | null
}
