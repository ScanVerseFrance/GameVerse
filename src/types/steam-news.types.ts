/** Shape mirrors `electron/services/steam-news.service.ts`. The renderer
 * never sees the raw Steam payload — fields are normalised + the body
 * is BBCode-stripped + truncated server-side. */
export interface SteamNewsItem {
  gid: string
  title: string
  url: string
  isExternalUrl: boolean
  author: string | null
  excerpt: string
  feedLabel: string | null
  date: number // unix seconds, as Steam returns
  tags: string[]
}
