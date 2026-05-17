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
