/**
 * Cross-source deduplication for JSON catalogue games (AnkerGames,
 * FitGirl, DODI, etc.). The user has multiple catalogues installed
 * so the same game shows up multiple times in Discover with slightly
 * different titles ("Game X" in one source, "Game X — Ultimate
 * Edition" in another). We group them by normalised base name, pick
 * the "best" variant as the primary tile, and surface the rest as
 * alternative sources on the game page.
 *
 * Scoring rules for the primary pick (per Hydra audit / user spec):
 *   • Premium editions weigh heaviest (Ultimate / GOTY / Complete
 *     / Deluxe / Definitive / Premium / Legendary).
 *   • Anything with an edition tag at all > no edition.
 *   • Each DLC tag adds a small bump.
 *   • OnlineFix tagged variants are preferred for multiplayer-heavy
 *     repacks (the user explicitly called out wanting multi-capable
 *     versions when offered).
 *   • Tiebreaker is most recent uploadDate so an Ultimate Edition
 *     from 2024 wins over an identical Ultimate from 2022.
 *
 * Pure utility — no React, no I/O, deterministic. Easy to unit-test
 * if we ever add Vitest.
 */
import { parseGameTitle, type ParsedTitle } from './title-parse'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

export interface DedupedGame {
  /** The "winning" entry — the one we render as the primary tile in
   *  Discover and direct users to when they click. */
  primary: JsonSourceSearchHit
  /** The other entries grouped under the same normalised name, in
   *  descending score order (best alternative first). Empty when
   *  the game only exists in one catalogue. */
  alternatives: JsonSourceSearchHit[]
  /** Lower-case stripped name used as the group key — useful for
   *  cross-page lookups (e.g. the game page asks for "all variants
   *  of this game"). */
  groupKey: string
  /** Combined entry count for the badge "X sources". */
  sourceCount: number
  /** Distinct repacker names in the group (deduped, order-preserved
   *  by first occurrence). Surface as chips on the tile so the user
   *  sees "FitGirl · AnkerGames · DODI" at a glance — same pattern
   *  Hydra renders on the Subnautica 2 card. */
  sourceNames: string[]
  /** The variant ID the tile should use for the artwork lookup. Per
   *  user spec: when ANY variant in the group is from AnkerGames,
   *  we prefer its cover over the primary's (AnkerGames ships
   *  beautiful character / box-art covers; FitGirl tends to fall
   *  back to a generic placeholder when the SGDB lookup misses).
   *  Falls back to the primary's id when no AnkerGames variant is
   *  in the group. */
  coverSourceId: string
}

/** Case-insensitive match against the user-facing source name. The
 *  AnkerGames JSON catalogue is named "AnkerGames" upstream but
 *  some users rename it locally — keep the match loose. */
function isAnkerGamesSource(sourceName: string | undefined | null): boolean {
  return typeof sourceName === 'string' && /anker\s*games?/i.test(sourceName)
}

const PREMIUM_EDITION_RX = /\b(ultimate|goty|complete|definitive|deluxe|premium|legendary|gold|platinum|enhanced|special)\b/i

/**
 * Aggressively normalise a title to a stable group key.
 *
 * The naive "lower + strip punctuation" approach left a bunch of
 * variants in separate groups because repacker titles carry a lot
 * of incidental noise that survives parseGameTitle:
 *   - file-size suffixes ("64.5 GB", "1.5 TB", "850 MB", "5 GBn")
 *   - dangling version remnants ("v1.131.0.0", "1.0.5")
 *   - year tags ("(2024)", "[2024]")
 *   - leftover edition keywords ("Remastered" gets stripped to
 *     edition by parseGameTitle BUT only when matched against
 *     EDITION_PATTERNS — some titles bury it inline and survive)
 *   - repacker tags ("FitGirl Repack", "DODI", "EMPRESS"…)
 *   - "+ N DLCs", "+ Unlocker", "+ OnlineFix" suffixes
 *
 * We strip all of that here as a safety net so the same game across
 * AnkerGames + FitGirl + DODI lands in one bucket. Sequel digits
 * are preserved (Spider-Man 2 ≠ Spider-Man) and ampersands are
 * kept (Sonic & Knuckles).
 *
 * Order matters: strip noise BEFORE collapsing whitespace so
 * pattern boundaries (\b) still match correctly.
 */
function normaliseGroupKey(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()

  // Strip everything inside brackets / parens / braces.
  s = s.replace(/\[[^\]]*\]/g, ' ')
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\{[^}]*\}/g, ' ')

  // ORDER MATTERS: file-size patterns FIRST, before version numbers.
  // "3.4 GB" needs to match as a unit; if the version regex eats
  // "3.4" first we'd leave a dangling "gb" in the key.
  // Matches: "64.5 gb", "5 gbn" (FitGirl), "850 mb", "1.5 tb",
  // "300kb", "2 gib".
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*[kmgt]i?b?n?\b/g, ' ')

  // Belt-and-braces: if parseGameTitle eat a "3.4" as a version
  // upstream, the trailing unit word ("gb", "mbn", "tb") would
  // dangle on its own. Strip standalone size units too.
  s = s.replace(/\b[kmgt]i?bn?\b/g, ' ')

  // Version numbers — chained back-to-back is the common FitGirl
  // shape ("v1.130.1.0v1.131.0.0"). \b doesn't anchor on digit↔
  // letter junctions (both are word chars, no transition), so the
  // first attempt always backed off mid-version. Drop the
  // boundary anchors and require at least one ".\d+" group so a
  // bare "2" in "Spider-Man 2" survives.
  s = s.replace(/v?\d+(?:\.\d+){1,3}/g, ' ')
  s = s.replace(/\bversion\s+\d+(?:\.\d+)*\b/g, ' ')
  s = s.replace(/\bbuild\s+\d+\b/g, ' ')

  // 4-digit years that are clearly tags (1990-2099). Standalone
  // numbers like "2" (Spider-Man 2) survive because they're not
  // 4 digits.
  s = s.replace(/\b(19|20|21)\d{2}\b/g, ' ')

  // DLC counts and packs.
  s = s.replace(/\+?\s*\d+\s*dlcs?\b/g, ' ')
  s = s.replace(/\+?\s*all\s+dlcs?\b/g, ' ')
  s = s.replace(/\bdlc\s+pack\b/g, ' ')

  // Edition keywords that may have leaked through parseGameTitle.
  // Match standalone OR followed by "edition".
  s = s.replace(
    /\b(deluxe|ultimate|goty|complete|definitive|premium|legendary|gold|platinum|enhanced|special|standard|digital|remaster(?:ed)?|game of the year)(\s+edition)?\b/g,
    ' ',
  )

  // Repacker / source tags.
  s = s.replace(
    /\b(fit ?girl|dodi|empress|el ?amigos|skidrow|codex|cpy|reloaded|hoodlum|plaza|razor1911|tinyiso|hi2u|prophet|anker ?games|free ?gog ?pcgames|repack(?:s)?)\b/g,
    ' ',
  )

  // FitGirl-specific localisation / build markers. These were the
  // smoking gun behind cross-source dedup misses: a FitGirl entry
  // titled "9-Bit Armies: A Bit Too Far - v1.1.2 + DLC + MULTi5" left
  // "multi5" in the key after the version/DLC strip, so it never
  // matched the AnkerGames "9-Bit Armies: A Bit Too Far" entry. Same
  // family: "Selective Download", "From X GB" (already covered by
  // size strip but the prefix word can leak), encoding/quality tags,
  // region acronyms, "Worldwide / WW" markers.
  s = s.replace(/\bmulti\s?\d+\b/g, ' ')                  // MULTi5, MULTi 12, multi2
  s = s.replace(/\bselective\s+download\b/g, ' ')         // FitGirl SD packs
  s = s.replace(/\bfrom\s+\d+(?:[.,]\d+)?\s*[kmgt]i?b?\b/g, ' ') // "From 2.2 GB"
  s = s.replace(
    /\b(optional|high\s+quality|hq\s+audio|audio|videos?|cutscenes?|texture(?:s)? pack|hd|4k|8k|uhd|sdr|bluray|dvd|cd|iso)\b/g,
    ' ',
  )
  s = s.replace(/\b(ww|worldwide|eu|usa?|na|jp|asia|row|region\s*free)\b/g, ' ')
  // Trailing release-info parens/brackets are stripped earlier; their
  // leftover keywords (proper, internal, rip, release) can still leak.
  s = s.replace(/\b(proper|internal|rip|release|final|launch)\b/g, ' ')

  // Optional "+ extras" suffixes (Unlocker, Trainer, OnlineFix…)
  s = s.replace(
    /\+?\s*\b(unlocker|trainer|cheats?|no[-\s]?drm|crack ?fix|online ?fix|goldberg|steam ?emu|multiplayer|co[-\s]?op|bonus(?:es)?|soundtrack|patch(?:es)?|update(?:s)?)\b/g,
    ' ',
  )

  // Drop apostrophes BEFORE the catch-all punctuation pass so
  // "Marvel's" and "Marvels" land in the same bucket.
  s = s.replace(/['’`]/g, '')

  // Drop remaining punctuation, keep alphanumerics + ampersand.
  s = s.replace(/[^a-z0-9& ]+/g, ' ')

  // Articles / connectors. "Marvel's Avengers - The Definitive
  // Edition" should group with "Marvel's Avengers" — the leftover
  // "the" after edition strip would otherwise keep them apart.
  // We keep these as a separate pass AFTER punctuation strip so
  // word boundaries match cleanly.
  s = s.replace(/\b(the|a|an|of|and|et|de|du|le|la|les|les|or)\b/g, ' ')

  return s.replace(/\s+/g, ' ').trim()
}

/** Numeric "this variant is more desirable" score. Higher = better. */
function scoreVariant(parsed: ParsedTitle, raw: JsonSourceSearchHit): number {
  let s = 0
  const edition = (parsed.edition ?? '').toLowerCase()
  if (PREMIUM_EDITION_RX.test(edition)) s += 6
  else if (edition) s += 2

  s += Math.min(3, parsed.dlcs?.length ?? 0)

  if (parsed.onlineFix) s += 2
  if (parsed.multiplayer) s += 0.5

  // AnkerGames preference bump. User spec: when two variants tie on
  // edition (both "Standard" / both "Deluxe"), pick AnkerGames over
  // FitGirl because AnkerGames ships preinstalled builds (drop the
  // folder, run the exe — no repack unpacker required) while FitGirl
  // is a compressed repack that needs the setup.exe + extraction step.
  // Weight 1.0: large enough to beat the upload-year tiebreaker (<0.1)
  // and the multiplayer fractional bump (0.5), small enough that a
  // genuine premium edition on FitGirl still wins over an AnkerGames
  // standard edition (6 > 1).
  if (isAnkerGamesSource(raw.sourceName)) s += 1.0

  // Newer upload wins ties — encode upload year directly into the
  // score so two Ultimate editions sort by recency. parseInt on the
  // first year-shaped token is tolerant of "Jul 2024" or
  // "2024-07-15".
  if (raw.uploadDate) {
    const yr = /\b(19|20|21)\d{2}\b/.exec(raw.uploadDate)
    if (yr) {
      const y = parseInt(yr[0], 10)
      // Add fractional weight: year 2024 → +0.024, 2020 → +0.020.
      // Always < 0.1 so a real edition bump dominates.
      s += y / 100000
    }
  }
  return s
}

/**
 * Run the dedup pass over a flat list of JsonSource games. Order is
 * preserved as much as possible — group keys appear in the order
 * their first entry shows up in the input, so a sort applied
 * upstream (popularity, name, etc.) survives intact.
 */
export function dedupeGamesAcrossSources(games: JsonSourceSearchHit[]): DedupedGame[] {
  if (games.length === 0) return []

  // Pre-parse once — title parsing is moderately heavy with all the
  // regex passes inside, so do it up front rather than per-iteration.
  const parsed = new Map<string, ParsedTitle>()
  for (const g of games) {
    parsed.set(g.id, parseGameTitle(g.title))
  }

  // Group by canonical Steam appid when available (Hydra-style),
  // fall back to normalised title key otherwise.
  //
  // The appid is resolved at import time by steam-apps.service —
  // every game that matched the GetAppList mirror carries the
  // canonical key. Two FitGirl + AnkerGames entries of "Marvel's
  // Spider-Man 2" both resolve to appid 2651280 and collapse into
  // a single tile, regardless of how messy the repacker titles
  // are.
  //
  // Rows without a resolved appid (genuinely non-Steam games, or
  // titles too garbled for the matcher) fall back to the legacy
  // title-based grouping. Same Map for both paths preserves
  // insertion order so upstream sorts stay stable.
  const groups = new Map<string, JsonSourceSearchHit[]>()
  for (const g of games) {
    const key =
      g.steamAppid && g.steamAppid > 0
        ? `appid:${g.steamAppid}`
        : `title:${normaliseGroupKey(g.title)}`
    if (key === 'title:') continue // empty normalised title
    const bucket = groups.get(key)
    if (bucket) bucket.push(g)
    else groups.set(key, [g])
  }

  const out: DedupedGame[] = []
  for (const [key, entries] of groups) {
    if (entries.length === 1) {
      const only = entries[0]!
      out.push({
        primary: only,
        alternatives: [],
        groupKey: key,
        sourceCount: 1,
        sourceNames: [only.sourceName],
        coverSourceId: only.id,
      })
      continue
    }
    // Sort by score descending — best variant first.
    const scored = entries
      .map((g) => ({ g, score: scoreVariant(parsed.get(g.id)!, g) }))
      .sort((a, b) => b.score - a.score)
    const primary = scored[0]!.g
    // Cover preference: if ANY variant comes from AnkerGames,
    // serve its artwork instead of the primary's. The user
    // explicitly asked for AnkerGames covers because they ship
    // bespoke character art per game; FitGirl + DODI rely on
    // generic Steam grid fallbacks that the SGDB lookup often
    // misses on. We still keep the primary's id for everything
    // else (download links, etc.) — only the artwork lookup is
    // re-routed.
    const ankerVariant = entries.find((e) => isAnkerGamesSource(e.sourceName))
    // Distinct source names, ordered by their appearance in `scored`
    // so the highest-quality variant (and its source name) leads
    // the list. Deduped via a Set so "FitGirl" doesn't appear
    // twice when the same repacker ships 2 editions of the game.
    const seenNames = new Set<string>()
    const sourceNames: string[] = []
    for (const { g } of scored) {
      if (!seenNames.has(g.sourceName)) {
        seenNames.add(g.sourceName)
        sourceNames.push(g.sourceName)
      }
    }
    out.push({
      primary,
      alternatives: scored.slice(1).map((s) => s.g),
      groupKey: key,
      sourceCount: entries.length,
      sourceNames,
      coverSourceId: ankerVariant ? ankerVariant.id : primary.id,
    })
  }
  return out
}

/**
 * For a single game ID, return the dedup group it belongs to. Used
 * by the game-page source picker so it can list all variants of the
 * currently-viewed game and highlight the recommended one. Returns
 * `null` when no other variants exist (single-source game).
 *
 * Pass the full catalogue list as `pool` — usually the result of
 * `useJsonSourceStore.allGames` or equivalent. We do the dedup pass
 * fresh because the pool can change as sources are added/removed.
 */
export function findVariantsForGame(
  targetId: string,
  pool: JsonSourceSearchHit[],
): DedupedGame | null {
  const target = pool.find((g) => g.id === targetId)
  if (!target) return null
  const targetKey = normaliseGroupKey(target.title)
  if (!targetKey) return null
  const matching = pool.filter((g) => normaliseGroupKey(g.title) === targetKey)
  if (matching.length === 0) return null
  const deduped = dedupeGamesAcrossSources(matching)
  return deduped[0] ?? null
}
