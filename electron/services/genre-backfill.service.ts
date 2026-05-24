/**
 * Backfill des genres Steam pour le filtre Catalogue.
 *
 * Problème : `game_artwork.genres` n'est rempli QUE lorsque l'user
 * ouvre la page d'un jeu (ce qui appelle artwork.service). Résultat :
 * tant que l'user n'a pas browsé 500 jeux, le filtre genres retourne
 * 0 résultat — il ne match que sur les jeux dont l'artwork est en
 * cache local.
 *
 * Solution : on déclenche un backfill background à l'ouverture de la
 * page Catalogue. Le job :
 *   1. Sélectionne les top N appids les plus populaires (owners_rank)
 *      qui n'ont PAS de ligne dans game_artwork (cache_key `appid:N`).
 *   2. Hit Steam storefront `appdetails?l=french` un par un avec
 *      throttling (1.2 req/s pour rester sous le rate-limit per-IP).
 *   3. Extrait genres + écrit dans game_artwork.
 *   4. Émet des events `genres:backfill` au renderer pour la
 *      progress bar.
 *
 * Singleton : un seul job actif à la fois. Si la page est rouverte
 * pendant que ça tourne, on no-op.
 *
 * Cooldown : on garde un timestamp en mémoire ; les re-déclenchements
 * dans les 30 min suivant le dernier lancement sont skipped.
 */
import type { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { debugLog } from './debug-log.service'

const APPDETAILS_URL =
  'https://store.steampowered.com/api/appdetails?l=french&cc=fr&appids='
const APPPAGE_URL = (appid: number) =>
  `https://store.steampowered.com/app/${appid}/?l=french&cc=fr`
const FETCH_TIMEOUT_MS = 6_000
/** Throttle — Steam tolère ~200 req / 5 min / IP. À 1.2 req/s on est
 *  largement sous la limite et un backfill de 500 jeux prend ~7 min.
 *  Avec 2 round-trips par appid (appdetails + page HTML pour les
 *  tags) on est à ~1.7 req/s effectifs, toujours OK. */
const INTER_REQUEST_DELAY_MS = 850
const COOLDOWN_MS = 30 * 60 * 1000

/** Cookie pour bypass l'age-gate Steam sur certaines pages app
 *  (M-rated, jeux d'horreur, etc.). Sans ça la page redirige vers
 *  agecheck et on ne récupère pas les tags. birthtime = 1996-01-01. */
const STEAM_AGEGATE_COOKIE = 'birthtime=820454400; mature_content=1; lastagecheckage=1-January-1996'

let getMainWindow: (() => BrowserWindow | null) | null = null
let runningJobId: string | null = null
let lastRunStartedAt = 0
let abortFlag = false

interface AppDetailsLite {
  [appid: string]: {
    success?: boolean
    data?: {
      genres?: Array<{ id?: string; description?: string }>
    }
  }
}

/** Schema version pour le backfill genres. Bump à chaque évolution
 *  qui change la NATURE des données stockées dans `genres` (ajout
 *  source, format différent, etc.) — pas pour les fixes mineurs.
 *
 *  v1 → genres officiels Steam appdetails uniquement (~3 par jeu)
 *  v2 → genres officiels + popular_tags scrapés (~23 par jeu)
 *
 *  Au boot, si la version stockée < BACKFILL_SCHEMA_VERSION, on
 *  wipe les rows game_artwork de source steam pour forcer un
 *  refetch avec la nouvelle stratégie. Les entries cover_url-only
 *  (sans genres) restent — elles ne portent pas le contrat de
 *  schema concerné. */
const BACKFILL_SCHEMA_VERSION = 2

function ensureSchemaVersion(): void {
  try {
    const db = getDatabase()
    db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
    const row = db
      .prepare("SELECT v FROM kv WHERE k = 'genre_backfill_schema_version'")
      .get() as { v: string } | undefined
    const stored = row ? parseInt(row.v, 10) || 0 : 0
    if (stored >= BACKFILL_SCHEMA_VERSION) return
    // Wipe les rows game_artwork qui portent des genres "thin" (v1)
    // pour qu'elles soient repompées avec les tags v2. On garde les
    // autres champs (cover_url, etc.) intact côté steam_catalogue —
    // c'est seulement game_artwork qu'on touche.
    const result = db
      .prepare(
        "UPDATE game_artwork SET genres = '[]', fetched_at = 0 WHERE external_source = 'steam' AND genres IS NOT NULL AND genres != '[]'",
      )
      .run()
    db.prepare(
      "INSERT OR REPLACE INTO kv (k, v) VALUES ('genre_backfill_schema_version', ?)",
    ).run(String(BACKFILL_SCHEMA_VERSION))
    debugLog('genre-backfill', 'schema bump → re-fetch needed', {
      from: stored,
      to: BACKFILL_SCHEMA_VERSION,
      wipedRows: result.changes,
    })
  } catch (e) {
    debugLog('genre-backfill', 'schema check failed', {
      error: (e as Error).message,
    })
  }
}

export function initGenreBackfill(
  getMain: () => BrowserWindow | null,
): void {
  getMainWindow = getMain
  ensureSchemaVersion()
}

function emit(channel: string, payload: unknown): void {
  try {
    getMainWindow?.()?.webContents.send(channel, payload)
  } catch {
    /* renderer not ready */
  }
}

/**
 * Lance le backfill. No-op si déjà en cours OU si le dernier run
 * date de moins du cooldown.
 *
 * @param limit nombre max d'appids à traiter (default 500)
 */
export async function startGenreBackfill(
  limit = 500,
): Promise<{ started: boolean; reason?: string }> {
  if (runningJobId) {
    return { started: false, reason: 'already_running' }
  }
  if (Date.now() - lastRunStartedAt < COOLDOWN_MS) {
    return { started: false, reason: 'cooldown' }
  }

  const db = getDatabase()
  // Top N appids POPULAIRES qui n'ont pas encore de genres en cache.
  // LEFT JOIN sur game_artwork : on garde ceux dont aucune ligne
  // appid:<N> existe OU dont la ligne existe mais genres est NULL/
  // chaîne vide / array vide '[]'.
  let rows: Array<{ appid: number }>
  try {
    rows = db
      .prepare(
        `
      SELECT c.appid
      FROM steam_catalogue c
      LEFT JOIN game_artwork a
        ON a.cache_key = 'appid:' || c.appid
      WHERE c.is_game = 1
        AND (a.genres IS NULL OR a.genres = '' OR a.genres = '[]')
      ORDER BY c.owners_rank DESC, c.score_rank DESC
      LIMIT ?
    `,
      )
      .all(limit) as Array<{ appid: number }>
  } catch (e) {
    debugLog('genre-backfill', 'select failed', { error: (e as Error).message })
    return { started: false, reason: 'db_error' }
  }

  if (rows.length === 0) {
    return { started: false, reason: 'nothing_to_do' }
  }

  const jobId = `genre-bf-${Date.now()}`
  runningJobId = jobId
  lastRunStartedAt = Date.now()
  abortFlag = false
  debugLog('genre-backfill', 'started', { count: rows.length, jobId })
  emit('genres:backfill', {
    kind: 'start',
    total: rows.length,
    done: 0,
    jobId,
  })

  // Fire-and-forget loop. On ne block PAS le caller IPC — l'user
  // continue d'utiliser l'app pendant que le backfill tourne.
  void (async () => {
    let done = 0
    let withGenres = 0
    for (const r of rows) {
      if (abortFlag) break
      try {
        // 2 round-trips parallèles : (a) genres "officiels" Steam
        // (max ~13 catégories), (b) tags populaires de la communauté
        // (~20 par jeu, beaucoup plus granulaires : "Course",
        // "Monde ouvert", "Souls-like", etc.). On dedup l'union
        // pour ne pas doublonner "Action" présent dans les 2.
        const [genres, tags] = await Promise.all([
          fetchGenresForAppid(r.appid),
          fetchTagsForAppid(r.appid),
        ])
        const merged = mergeUnique(genres ?? [], tags ?? [])
        if (merged.length > 0) {
          persistGenres(r.appid, merged)
          withGenres += 1
        } else {
          // Marker entry — empty genres array. Évite qu'on retry
          // cet appid au prochain backfill (no-op rapide via le LEFT
          // JOIN ci-dessus qui exclut désormais cette ligne).
          persistGenres(r.appid, [])
        }
      } catch (e) {
        debugLog('genre-backfill', 'appid failed', {
          appid: r.appid,
          error: (e as Error).message,
        })
      }
      done += 1
      // Progress event tous les 10 appids pour ne pas saturer l'IPC.
      if (done % 10 === 0 || done === rows.length) {
        emit('genres:backfill', {
          kind: 'progress',
          done,
          total: rows.length,
          withGenres,
          jobId,
        })
      }
      await sleep(INTER_REQUEST_DELAY_MS)
    }
    debugLog('genre-backfill', 'done', { done, withGenres, jobId })
    emit('genres:backfill', {
      kind: 'done',
      done,
      total: rows.length,
      withGenres,
      jobId,
    })
    runningJobId = null
  })()

  return { started: true }
}

export function cancelGenreBackfill(): void {
  abortFlag = true
}

export function getGenreBackfillStatus(): {
  running: boolean
  jobId: string | null
  lastRunStartedAt: number
} {
  return {
    running: runningJobId !== null,
    jobId: runningJobId,
    lastRunStartedAt,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchGenresForAppid(appid: number): Promise<string[] | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(APPDETAILS_URL + appid, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Nexus-Launcher/0.5',
        Accept: 'application/json',
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as AppDetailsLite
    const entry = body[String(appid)]
    if (!entry?.success || !entry.data) return null
    return (entry.data.genres ?? [])
      .map((g) => g.description ?? '')
      .filter((d) => d.length > 0)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

/** Scrape les tags populaires de la communauté Steam depuis la page
 *  app. Sont MUCH plus riches que les `genres` officiels (~3 par jeu)
 *  — typiquement 20 tags par jeu : "Course", "Monde ouvert", "Souls-
 *  like", "Open World", etc. C'est CE filtre que l'UI Steam utilise.
 *
 *  Format dans le HTML :
 *    <a href="...tags/fr/Course/..." class="app_tag">Course</a>
 *
 *  L'age-gate cookie est nécessaire pour les jeux M-rated qui sinon
 *  redirigent vers /agecheck/. Sans ça on perd Doom, Mortal Kombat,
 *  etc. */
async function fetchTagsForAppid(appid: number): Promise<string[] | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(APPPAGE_URL(appid), {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Cookie: STEAM_AGEGATE_COOKIE,
      },
    })
    if (!res.ok) return null
    const html = await res.text()
    // Sanity check : on doit voir le block popular_tags ; sinon
    // c'est probablement une page agecheck ou une redirection.
    if (!html.includes('popular_tags') && !html.includes('app_tag')) {
      return null
    }
    // Match `<a ... class="app_tag" ...>Texte</a>`. Le texte peut
    // contenir des entités HTML (&amp;, &eacute;) et beaucoup d'
    // espace/tabs avant/après — on trim ferme.
    const tags = new Set<string>()
    const tagRe =
      /<a[^>]*class="app_tag[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(html)) !== null) {
      const raw = m[1]
      // Strip nested tags + decode entités basiques + trim espaces.
      const clean = raw
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&eacute;/g, 'é')
        .replace(/&egrave;/g, 'è')
        .replace(/&agrave;/g, 'à')
        .replace(/&ccedil;/g, 'ç')
        .replace(/&ucirc;/g, 'û')
        .replace(/&ocirc;/g, 'ô')
        .replace(/&icirc;/g, 'î')
        .replace(/&acirc;/g, 'â')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/\s+/g, ' ')
        .trim()
      // Filtre : skip les pseudo-tags vides (le "+" du bouton add,
      // les chips affichant juste une icône, etc.).
      if (clean && clean.length >= 2 && !/^[+\-]+$/.test(clean)) {
        tags.add(clean)
      }
    }
    return Array.from(tags)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

/** Union case-insensitive — dedupe les éléments qui apparaissent dans
 *  les deux listes (ex. "Action" présent dans genres ET tags). Garde
 *  la casing du premier match pour stabilité. */
function mergeUnique(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of [...a, ...b]) {
    const k = v.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function persistGenres(appid: number, genres: string[]): void {
  const now = Date.now()
  try {
    getDatabase()
      .prepare(
        `INSERT INTO game_artwork
          (cache_key, external_source, external_id, cover_url, hero_url, header_url, logo_url,
           description, developer, publisher, release_date, genres, screenshots, videos,
           cached_at, fetched_at)
         VALUES (?, 'steam', ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, ?, '[]', '[]',
                 ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           external_id = excluded.external_id,
           genres = excluded.genres,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        `appid:${appid}`,
        String(appid),
        JSON.stringify(genres),
        now,
        now,
      )
  } catch {
    /* schema not ready / write error — best-effort */
  }
}
