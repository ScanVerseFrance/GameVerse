#!/usr/bin/env node
/**
 * Build a single TS manifest of all cosmetic assets shipped in
 * `public/cosmetics/`. We bundle the file list at build time rather than
 * reading the directory at runtime because:
 *  - Electron's renderer can't `fs.readdir` (no Node access)
 *  - we want sorted, deterministic catalogs
 *  - the picker UIs need the list synchronously to render
 *
 * Re-run this script whenever you add or remove files in
 * `public/cosmetics/avatar_decorations/`, `public/cosmetics/nameplates/`,
 * or `public/cosmetics/profile_effects/`.
 *
 *   node scripts/build-cosmetics-manifest.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUB = path.join(ROOT, 'public', 'cosmetics')

/** Strip extension + return a slug usable as a stable id. Keeps spaces +
 * punctuation collapsed to dashes so file renames are detectable. */
function slug(name) {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function basename(name) {
  return name.replace(/\.[a-z0-9]+$/i, '')
}

/* ── 1) Avatar decorations: single PNG per item. ── */
const decorationFiles = readdirSync(path.join(PUB, 'avatar_decorations'))
  .filter((f) => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b))
const avatarDecorations = decorationFiles.map((f) => ({
  id: slug(f),
  name: basename(f),
  file: `/cosmetics/avatar_decorations/${f}`,
}))

/* ── 2) Nameplates: single WEBM video per item + palette metadata. ── */
const palettes = JSON.parse(readFileSync(path.join(PUB, 'nameplates_palettes.json'), 'utf-8'))
const nameplateFiles = readdirSync(path.join(PUB, 'nameplates'))
  .filter((f) => /\.webm$/i.test(f))
  .sort((a, b) => a.localeCompare(b))
const nameplates = nameplateFiles.map((f) => {
  const p = palettes[f] ?? {}
  return {
    id: slug(f),
    name: basename(f),
    file: `/cosmetics/nameplates/${f}`,
    palette: p.palette ?? null,
    darkHex: p.dark_hex ?? null,
    lightHex: p.light_hex ?? null,
    gradientCss: p.gradient_css ?? null,
  }
})

/* ── 3) Profile effects: N parts per item ("Foo_part1.png", "Foo_part2.png").
 *
 * Each part also carries timing metadata extracted from the APNG at scrape
 * time and persisted in `profile_effects_durations.json` (one entry per
 * effect basename, ordered low → high to match the part1, part2, … files) :
 *
 *   { "A Bit Batty (Treat)": [
 *       { "durationMs": 2988, "plays": 1 },   // part1 — one-shot intro
 *       { "durationMs": 5905, "plays": 0 }    // part2 — ambient loop
 *     ] }
 *
 * `plays = 1` → one-shot intro that freezes on the last frame after a
 *               single playthrough. Re-mounted occasionally by the player
 *               on a long cycle so the dramatic intro replays.
 * `plays = 0` → infinite ambient loop; the player gives it a 5 s gap
 *               between iterations so it doesn't drone non-stop under
 *               the intro layer.
 *
 * The renderer in `ExtendedPlayer.tsx` reads these per-part to drive its
 * `ProfileEffectLayer` timings — without them the cosmetics would just
 * cycle continuously and lose the Discord "intro + ambient" feel. */
const durationsByLabel = JSON.parse(
  readFileSync(path.join(PUB, 'profile_effects_durations.json'), 'utf-8'),
)
const effectFiles = readdirSync(path.join(PUB, 'profile_effects'))
  .filter((f) => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b))
const effectGroups = new Map()
for (const f of effectFiles) {
  const m = f.match(/^(.+?)_part(\d+)\.png$/i)
  if (!m) continue
  const [, base, partStr] = m
  const id = slug(base)
  if (!effectGroups.has(id)) {
    effectGroups.set(id, { id, name: base, parts: [] })
  }
  const partIndex = parseInt(partStr, 10)
  // Lookup is by raw label (`base`) — durations.json keys are the scraper's
  // original case-sensitive filename, not the slug. Default to a sane
  // fallback so a single missing entry doesn't break the build.
  const partMeta = durationsByLabel[base]?.[partIndex - 1]
  effectGroups.get(id).parts.push({
    index: partIndex,
    file: `/cosmetics/profile_effects/${f}`,
    durationMs: partMeta?.durationMs ?? 4000,
    plays: partMeta?.plays ?? 0,
  })
}
const profileEffects = [...effectGroups.values()]
  .map((g) => {
    const parts = g.parts.sort((a, b) => a.index - b.index)
    // Aggregate longest-part duration — consumers that just want a quick
    // "how long is this effect overall" hint (e.g. the global cycle in
    // the player) read this instead of scanning parts.
    const durationMs = parts.reduce((m, p) => Math.max(m, p.durationMs || 0), 0) || 4000
    return { ...g, parts, durationMs }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

/* ── Emit the manifest. ── */
const out = {
  generatedAt: new Date().toISOString(),
  counts: {
    avatarDecorations: avatarDecorations.length,
    nameplates: nameplates.length,
    profileEffects: profileEffects.length,
  },
  avatarDecorations,
  nameplates,
  profileEffects,
}

const outPath = path.join(ROOT, 'src', 'config', 'cosmeticsManifest.json')
writeFileSync(outPath, JSON.stringify(out, null, 2))

console.log(`✓ Wrote ${outPath}`)
console.log(`  avatarDecorations: ${avatarDecorations.length}`)
console.log(`  nameplates:        ${nameplates.length}`)
console.log(`  profileEffects:    ${profileEffects.length}`)
