/**
 * Repacker-style title parser. Hydra-style listings cram everything into the
 * `title` field — version, edition, DLC count, repacker tag — and the result
 * is ugly to display ("Hollow Knight Silksong – v1.0.28324", "Wardrum Rhythm
 * Master Edition – v1.0.10 + Bonus OST").
 *
 * This pulls those fragments out so the UI can render them in their proper
 * slots: the clean game name as the H1, the version next to the release
 * date, and DLCs in their own section.
 *
 * Conservative by design: anything we're not confident about goes back into
 * the `name`. Better to leave a token in the name than to misclassify a
 * meaningful word as an edition tag.
 */
export interface ParsedTitle {
  /** Clean game name with version/edition/dlc tags stripped. */
  name: string
  /** Version string (e.g. "v1.0.28324", "Build 12345") or null. */
  version: string | null
  /** Edition / variant (e.g. "Deluxe Edition", "GOTY") or null. */
  edition: string | null
  /** DLC / content additions mentioned in the title (one entry per fragment). */
  dlcs: string[]
  /** True when the release explicitly mentions Multiplayer / Co-op / Online
   * play — surfaced as a separate badge on the game page because it's a
   * higher-signal feature than another DLC mention. */
  multiplayer: boolean
  /** True when the release advertises an OnlineFix / CrackFix / GoldbergFix
   * patch — a separate signal from generic "Multiplayer inclus" because it
   * tells the user the crack-side workaround is bundled (otherwise multi
   * may technically be "in the game" but unplayable without an extra patch). */
  onlineFix: boolean
  /** Repacker (e.g. "FitGirl", "DODI") parsed from bracketed tags. */
  repacker: string | null
}

const VERSION_PATTERNS = [
  /\bv(?:ersion\s*)?\d+(?:[._]\d+)*[a-z]?(?:\.\d+)*/i,        // v1.0.28324, v1.0a, v2
  /\bBuild\s+\d{3,}/i,                                          // Build 12345
  /\b\d+\.\d+(?:\.\d+){0,3}[a-z]?\b/,                          // 1.0.28324, 1.21
  /\bRev\.?\s*\d+/i,                                            // Rev. 4
  /\bUpdate\s+\d+/i,                                            // Update 12
]

const EDITION_PATTERNS = [
  /\b(?:The\s+)?(?:Digital\s+|Ultimate\s+|Premium\s+|Definitive\s+|Complete\s+|Deluxe\s+|Anniversary\s+|Director'?s?\s+Cut\s+|Game\s+of\s+the\s+Year\s+|GOTY\s+|Standard\s+|Special\s+|Collector'?s?\s+|Enhanced\s+|Legendary\s+|Master\s+|Royal\s+|Ascendant\s+|Founders?\s+|Gold\s+|Platinum\s+|Anniversary\s+|Remastered\s+)?Edition\b/i,
  /\bGOTY\b/i,
  /\bRemastered\b/i,
  // Standalone qualifiers that aren't followed by "Edition" but mean the
  // same thing in repack-titles. Match WHOLE word so they don't gobble
  // "Digital Foundry" or similar.
  /\bDigital(?=\s|,|$)/i,
  /\bRemaster(?=\s|,|$)/i,
]

const DLC_PATTERNS = [
  // Forms with explicit "+" — most common in Hydra-style catalogs.
  /\b\+\s*\d+\s*DLCs?\b/i,                                     // + 64 DLCs
  /\b\+\s*all\s+DLCs?\b/i,                                     // + all DLCs
  /\b\+\s*Bonus\s+[A-Za-z]+/i,                                 // + Bonus OST
  /\b\+\s*Soundtrack\b/i,                                      // + Soundtrack
  /\b\+\s*Season\s+Pass\b/i,                                   // + Season Pass
  /\bIncludes?\s+\d+\s+DLCs?\b/i,                              // includes 5 DLCs
  // Bareforms without "+" — FitGirl titles like "Forza Horizon 6 10 DLCs +
  // Multiplayer" cram them straight into the name without a separator. We
  // match the number-DLC pair plus a few common bonuses; the leading word
  // boundary keeps "1DLC" embedded in other tokens from matching.
  /\b\d+\s*DLCs?\b/i,                                           // 10 DLCs
  /\ball\s+DLCs?\b/i,                                           // all DLCs
  /\bBonus\s+(?:OST|Soundtrack|Content|Pack)\b/i,               // Bonus OST
  /\bSeason\s+Pass\b/i,                                         // Season Pass
  /\bSoundtrack\s+(?:Pack|Edition)?\b/i,                        // Soundtrack
  // Repack extras that aren't really DLC but should be lifted out of the
  // title — they tell the user something useful and the cover lookup
  // would otherwise choke on them.
  /\bUnlocker\b/i,                                              // + Unlocker (DLC unlocker)
  /\bDLC\s+Unlocker\b/i,
  /\bTrainer\b/i,                                               // built-in trainer
  /\bCheats?\b/i,                                               // + Cheats
  /\bNo[-\s]?DRM\b/i,
  /\bAll\s+(?:Updates|Patches)\b/i,
]

const MULTIPLAYER_PATTERNS = [
  /\bMultiplayer\b/i,
  /\bMulti[-\s]?player\b/i,
  /\bMulti[-\s]?joueur\b/i,                                     // FR catalogs
  /\bOnline(?:\s+Play)?\b/i,
  /\bCo[-\s]?op(?:erative)?\b/i,
  /\bLAN(?:\s+Play)?\b/i,
  /\bCrack(?:fix)?(?:ed)?\s+Online\b/i,
]

/** OnlineFix / CrackFix / Goldberg-Fix — separate from generic multiplayer
 * because it tells the user the crack-side patch is bundled (without it,
 * multi might be technically present but unplayable). */
const ONLINE_FIX_PATTERNS = [
  /\bOnline[-\s]?Fix\b/i,
  /\bCrack[-\s]?Fix\b/i,
  /\bGoldberg(?:[-\s]?Fix)?\b/i,
  /\bSteam[-\s]?Emu\b/i,
]

const REPACKER_PATTERNS = [
  /\[(FitGirl(?:\s+Repack)?)\]/i,
  /\[(DODI(?:\s+Repack)?)\]/i,
  /\[(KaOs(?:Krew)?)\]/i,
  /\[(ElAmigos)\]/i,
  /\[(EMPRESS)\]/i,
  /\[(RUNE)\]/i,
  /\[(CODEX)\]/i,
  /\[(SKIDROW)\]/i,
  /\[(GOG)\]/i,
  /\[(Repack(?:-[A-Za-z]+)?)\]/i,
]

/** Tokens we use to split the title into "primary part" and "tail metadata".
 * Hydra-style titles overwhelmingly use " – " (en dash) or " - " (hyphen
 * with spaces) as the separator between the game name and the version. */
const PRIMARY_SEPARATOR = /\s+[–—-]\s+/

/** Helper: strip matches of any pattern in `patterns` from `text`, returning
 * the stripped text + the deduped list of captures. Stops scanning once no
 * more matches are found. */
function extractAll(text: string, patterns: RegExp[]): { rest: string; matches: string[] } {
  let rest = text
  const matches: string[] = []
  const seen = new Set<string>()
  for (const re of patterns) {
    let m: RegExpMatchArray | null
    // Defensive cap: pathological inputs could otherwise loop. 50 dlc-style
    // tags in a single title is already absurd.
    let safety = 50
    while (safety-- > 0 && (m = rest.match(re)) !== null) {
      const cleaned = m[0].replace(/^\+\s*/, '').trim()
      const key = cleaned.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        matches.push(cleaned)
      }
      rest = rest.replace(re, ' ').trim()
    }
  }
  return { rest, matches }
}

export function parseGameTitle(raw: string): ParsedTitle {
  if (!raw) {
    return {
      name: '',
      version: null,
      edition: null,
      dlcs: [],
      multiplayer: false,
      onlineFix: false,
      repacker: null,
    }
  }

  let working = raw.trim()
  let version: string | null = null
  let edition: string | null = null
  const dlcs: string[] = []
  let multiplayer = false
  let onlineFix = false
  let repacker: string | null = null

  // 1) Pull the repacker tag first — it's always in brackets at the end.
  for (const re of REPACKER_PATTERNS) {
    const m = working.match(re)
    if (m) {
      repacker = m[1].replace(/\s*Repack$/i, '').trim()
      working = working.replace(re, '').trim()
      break
    }
  }

  // 2) Remove any leftover bracketed tags ([Repack], [v1.2], etc.)
  working = working.replace(/\[[^\]]+\]/g, '').trim()

  // 3) OnlineFix / CrackFix flag FIRST (before MP) — these often appear in
  // combos like "+ Multiplayer + OnlineFix" and we want both flags to fire
  // even though the words overlap.
  for (const re of ONLINE_FIX_PATTERNS) {
    if (re.test(working)) {
      onlineFix = true
      working = working.replace(re, ' ')
    }
  }
  // 4) Multiplayer flag — pull it BEFORE the head/tail split so a title like
  // "Forza Horizon 6 10 DLCs + Multiplayer" gets cleanly stripped of the
  // word even though it lives in the dlc-tail of the title.
  for (const re of MULTIPLAYER_PATTERNS) {
    if (re.test(working)) {
      multiplayer = true
      working = working.replace(re, ' ')
    }
  }

  // 4) Split at the primary separator if present. Everything AFTER the
  // separator is metadata candidates; the part BEFORE is the game name +
  // possibly inline edition tags.
  const sepIdx = working.search(PRIMARY_SEPARATOR)
  let head = working
  let tail = ''
  if (sepIdx >= 0) {
    head = working.slice(0, sepIdx).trim()
    tail = working.slice(sepIdx).replace(PRIMARY_SEPARATOR, '').trim()
  }

  // 5) Tail: extract version + DLC mentions iteratively.
  if (tail) {
    for (const re of VERSION_PATTERNS) {
      const m = tail.match(re)
      if (m) {
        version = m[0]
        tail = tail.replace(re, '').trim()
        break
      }
    }
    const tailExtract = extractAll(tail, DLC_PATTERNS)
    dlcs.push(...tailExtract.matches)
    tail = tailExtract.rest

    // Whatever remains in tail (rare): if it looks meaningful, push it back
    // to the name so we don't lose info.
    tail = tail.replace(/^[+,\s]+|[+,\s]+$/g, '').trim()
    if (tail && tail.length > 1 && !/^[\d.]+$/.test(tail)) {
      head = `${head} ${tail}`.trim()
    }
  }

  // 6) Edition extraction — multi-pass + multi-target. Strip EVERY edition
  // qualifier we find in the head (not just the first), but prefer the
  // most-informative one for display ("Deluxe Edition" beats "Digital").
  // Repacker titles routinely chain qualifiers ("Marvel's Spider-Man 2
  // Digital 1.131.0.0 Deluxe Edition") and a single-match pass would
  // strip one and leave the other dangling in the name.
  const editionMatches: string[] = []
  for (const re of EDITION_PATTERNS) {
    let safety = 5
    let m: RegExpMatchArray | null
    while (safety-- > 0 && (m = head.match(re)) !== null) {
      editionMatches.push(m[0].trim())
      head = head.replace(re, ' ').trim()
    }
  }
  if (editionMatches.length > 0) {
    // Prefer matches containing "Edition" (Deluxe Edition > Digital alone),
    // then the longest one as a tiebreaker.
    edition =
      editionMatches
        .filter((e) => /Edition\b/i.test(e))
        .sort((a, b) => b.length - a.length)[0] ??
      editionMatches.sort((a, b) => b.length - a.length)[0]
  }

  // 7) Last-pass version scan on the head.
  if (!version) {
    for (const re of VERSION_PATTERNS) {
      const m = head.match(re)
      if (m) {
        version = m[0]
        head = head.replace(re, '').trim()
        break
      }
    }
  }

  // 8) Last-pass DLC scan on the head — catches Forza-style titles where
  // "10 DLCs" sits inside the name with no separator at all
  // ("Forza Horizon 6 10 DLCs"). Runs after version extraction so we don't
  // accidentally re-grab a version number as a DLC count.
  const headExtract = extractAll(head, DLC_PATTERNS)
  for (const m of headExtract.matches) {
    const key = m.toLowerCase()
    if (!dlcs.some((d) => d.toLowerCase() === key)) dlcs.push(m)
  }
  head = headExtract.rest

  // 9) Final cleanup. Repack-style titles leave a lot of orphaned punctuation
  // after we strip versions/DLCs (double pluses, dangling commas, en-dash
  // pairs). Squash everything into a single clean string.
  const name = head
    // Collapse "  +  +  " or ", ," or any cluster of separator punctuation
    // into a single space.
    .replace(/([\s,·\-–—+])\s*[,·\-–—+]+/g, '$1')
    .replace(/[\s·\-–—+,]+$/g, '')
    .replace(/^[\s·\-–—+,]+/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    name: name || raw.trim(),
    version,
    edition,
    dlcs,
    multiplayer,
    onlineFix,
    repacker,
  }
}
