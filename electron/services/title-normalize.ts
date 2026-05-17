/**
 * Title normalization ported from Hydra
 * (https://github.com/hydralauncher/hydra/blob/main/src/shared/index.ts).
 *
 * Used both to clean user-facing titles before searching artwork sources AND
 * to pre-compute the searchable column on the local Steam app catalog — same
 * function on both sides means exact matches survive the round-trip.
 *
 * The character map flattens accented Unicode to ASCII (CamelCase aware).
 * The symbol stripper drops everything that isn't [A-Za-z0-9 ], which is
 * crucial — repacker titles bury the real name under `[FitGirl Repack]`,
 * `(v1.0.24.2)`, `~Kimetsu no Yaiba~` and similar noise.
 */

// Inline char map — covers the most common Latin accented characters that
// show up in game titles (Pokémon, Hades, etc.). Copied from Hydra's
// shared/char-map.ts (MIT license, attribution preserved).
const CHAR_MAP: Record<string, string> = {
  À: 'A', Á: 'A', Â: 'A', Ã: 'A', Ä: 'A', Å: 'A', Æ: 'AE',
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', æ: 'ae',
  Ç: 'C', ç: 'c',
  È: 'E', É: 'E', Ê: 'E', Ë: 'E',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  Ì: 'I', Í: 'I', Î: 'I', Ï: 'I',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  Ð: 'D', ð: 'd',
  Ñ: 'N', ñ: 'n',
  Ò: 'O', Ó: 'O', Ô: 'O', Õ: 'O', Ö: 'O', Ø: 'O', Œ: 'OE',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', œ: 'oe',
  Ù: 'U', Ú: 'U', Û: 'U', Ü: 'U',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  Ý: 'Y', ý: 'y', ÿ: 'y',
  Š: 'S', š: 's',
  Ž: 'Z', ž: 'z',
  ß: 'ss',
}

const CHAR_MAP_REGEX = new RegExp(Object.keys(CHAR_MAP).join('|'), 'g')

const EDITION_REGEX =
  /(The |Digital )?(GOTY|Deluxe|Standard|Ultimate|Definitive|Enhanced|Collector's|Premium|Digital|Limited|Anniversary|Supporter|Mercenaries|Reloaded|Game of the Year|Special|Chairman|Complete|Full Experience|[0-9]{4}) Edition/gi

const BUNDLE_REGEX =
  /\b(Deluxe|Ultimate|Complete|Premium|Supporter|Bundle|Pack|Pass)\b/gi

const VERSION_REGEX = /\bv?\d+\.[\d.]+(?:-[\w.]+)?\b/g

const DLC_REGEX = /\+\s*\d+\s*(DLCs?|Bonuses?|Bonus|OST)[\w\s+]*$/gi

const REPACKER_REGEX =
  /\b(FitGirl|DODI|EMPRESS|CODEX|RUNE|RELOADED|SKIDROW|PROPHET|MULTi\d*|Repack(s|ed)?|Selective Download)\b/gi

const BUILD_REGEX = /\bBuild\s+\d+/gi

/** Repacker extras that aren't part of the canonical game name: "Unlocker"
 * (DLC unlocker), built-in trainer/cheats, crack-fixes, etc. Stripping
 * these BEFORE we hit the artwork search is critical — without it, SGDB's
 * autocomplete on "Marvel's Spider-Man 2 Unlocker" can return a completely
 * different Marvel-branded game. */
const EXTRAS_REGEX =
  /\b(?:Unlocker|DLC\s+Unlocker|Trainer|Cheats?|No[-\s]?DRM|All\s+(?:Updates|Patches)|Online[-\s]?Fix|Crack[-\s]?Fix|Goldberg(?:[-\s]?Fix)?|Steam[-\s]?Emu|Multiplayer|Multi[-\s]?player|Co[-\s]?op(?:erative)?)\b/gi

/** Standalone "Digital" / "Remastered" / etc. that AREN'T followed by
 * "Edition" — they live as bare descriptors in repack titles ("Spider-Man
 * 2 Digital , v1.0"). Same treatment as edition words for cover lookup. */
const STANDALONE_EDITION_REGEX = /\b(?:Digital|Remastered|Premium|Deluxe|Ultimate|Definitive|Complete|Standard|Special|Gold|Platinum|Founders?|GOTY)(?=\s|,|\+|$)/gi

/**
 * Hydra-style normalization. Lowercased ASCII, with everything that's not a
 * letter, digit, or space stripped out. Equivalent inputs collapse to the
 * same string so equality comparison alone is enough to match titles across
 * sources.
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(CHAR_MAP_REGEX, (m) => CHAR_MAP[m] ?? m)
    .replace(/\(\d{4}\)/g, ' ') // strip release year in parens
    .replace(/\[[^\]]*\]/g, ' ') // strip [bracketed] tags entirely
    .replace(/\([^)]*\)/g, ' ') // strip (parens) entirely (versions, etc.)
    .replace(/~[^~]*~/g, ' ') // strip ~subtitle~ markers
    .replace(EXTRAS_REGEX, ' ')              // Unlocker / Trainer / OnlineFix / etc.
    .replace(DLC_REGEX, ' ')
    .replace(EDITION_REGEX, ' ')             // "Deluxe Edition" etc.
    .replace(STANDALONE_EDITION_REGEX, ' ')  // bare "Digital", "Remastered"
    .replace(REPACKER_REGEX, ' ')
    .replace(VERSION_REGEX, ' ')
    .replace(BUILD_REGEX, ' ')
    .replace(BUNDLE_REGEX, ' ')
    .replace(/[._]/g, ' ') // dots and underscores → space
    .replace(/\xa0/g, ' ') // nbsp → space
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ') // drop everything else
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract `dn=…` from a magnet URI (URL-decoded). */
export function extractDisplayNameFromMagnet(uri: string): string | null {
  try {
    if (!/^magnet:\?/i.test(uri)) return null
    const q = uri.slice(uri.indexOf('?') + 1)
    for (const pair of q.split('&')) {
      const [k, v] = pair.split('=')
      if (k?.toLowerCase() === 'dn' && v) {
        return decodeURIComponent(v.replace(/\+/g, ' '))
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Generate progressively shorter variants of the title — exact match,
 * before-subtitle, first-N-words. Used as a fallback chain when the strict
 * normalized form doesn't hit.
 */
export function titleVariants(raw: string): string[] {
  const out = new Set<string>()
  const push = (s: string) => {
    const t = normalizeTitle(s)
    if (t.length >= 3 && t.length <= 120) out.add(t)
  }

  push(raw)
  // Before subtitle separator
  for (const sep of [':', ' - ', ' – ', ' — ', ' | ']) {
    const idx = raw.indexOf(sep)
    if (idx > 3) push(raw.slice(0, idx))
  }
  // First-N words (after normalization)
  const words = normalizeTitle(raw).split(' ').filter(Boolean)
  for (const n of [5, 4, 3, 2]) {
    if (words.length > n) push(words.slice(0, n).join(' '))
  }

  return [...out]
}
