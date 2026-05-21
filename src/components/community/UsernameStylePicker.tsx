/**
 * UsernameStylePicker — direct port of ScanVerse's
 * frontend/src/components/profile/UsernameCustomisationPickers.jsx.
 *
 * The user explicitly asked for "TU VAS DANS LE CODE SOURCE ET TU
 * FAIS LA MEME CHOSE EN 1x1" — this file mirrors the original
 * line-by-line, just translated to TS + the launcher's auth store
 * (no `api` service / `toast` wrapper). Every visual decision
 * (active-tile blue tint, font tiles rendered in their own face,
 * colour swatch row, bi-colour toggle hidden on rainbow) is
 * preserved verbatim.
 *
 * Persistence: each pick fires a fire-and-forget patch via
 * `useAuthStore.updateProfile`. The store optimistically updates the
 * local user record, so the preview reacts immediately even if the
 * round-trip is in-flight.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import {
  USERNAME_FONTS,
  USERNAME_FONTS_BY_ID,
  USERNAME_ANIMATIONS,
  USERNAME_ANIMATIONS_BY_ID,
  USERNAME_COLOR_SWATCHES,
  BI_COLOR_INCOMPATIBLE_ANIMATIONS,
  PROFILE_ENTRY_ANIMATIONS,
  ensureFontLoaded,
} from '@/config/usernameCustomisations'

// Mirror the ScanVerse active-tile styling — soft indigo wash with a
// brighter indigo border. The user explicitly asked for the "rectangle
// bleu" used on the font tiles to be consistent across every picker.
const ACTIVE_TILE_BG     = 'rgba(99, 102, 241, 0.18)'
const ACTIVE_TILE_BORDER = '1px solid rgba(99, 102, 241, 0.7)'
const IDLE_TILE_BG       = '#0a0a0f'
const IDLE_TILE_BORDER   = '1px solid rgba(255,255,255,0.06)'

export function UsernameStylePicker() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  // Local mirrors of the persisted fields — bound to the picker UI and
  // patched optimistically on each interaction. Reset whenever the
  // upstream user record changes (e.g. logout / login).
  const [selectedFont, setSelectedFont] = useState<string>(user?.usernameFont ?? 'default')
  const [selectedAnim, setSelectedAnim] = useState<string>(user?.usernameAnimation ?? 'none')
  const [selectedColor, setSelectedColor] = useState<string | null>(user?.usernameColor ?? null)
  const [selectedColor2, setSelectedColor2] = useState<string | null>(user?.usernameColor2 ?? null)
  const [colorAnimated, setColorAnimated] = useState<boolean>(!!user?.usernameColor2)

  useEffect(() => {
    setSelectedFont(user?.usernameFont ?? 'default')
    setSelectedAnim(user?.usernameAnimation ?? 'none')
    setSelectedColor(user?.usernameColor ?? null)
    setSelectedColor2(user?.usernameColor2 ?? null)
    setColorAnimated(!!user?.usernameColor2)
  }, [user?.id])

  // Bi-colour incompatibility — rainbow paints its own multi-hue
  // gradient so a 2-colour cycle on top would fight for the same
  // background-clip slot. Hide the toggle when rainbow is active.
  const biColorAllowed = !BI_COLOR_INCOMPATIBLE_ANIMATIONS.has(selectedAnim)
  const effectiveAnimated = colorAnimated && biColorAllowed

  // Eagerly inject every Google-font catalogue entry's `<link>` so the
  // tile labels render in their own typeface from the first paint —
  // matches ScanVerse's pre-load on mount. Cheap because the picker
  // only mounts once on the Settings page.
  useEffect(() => {
    USERNAME_FONTS.forEach((f) => f.googleFont && ensureFontLoaded(f.id))
  }, [])

  async function pickFont(id: string): Promise<void> {
    if (id === selectedFont) return
    setSelectedFont(id)
    ensureFontLoaded(id)
    await updateProfile({ usernameFont: id })
  }

  async function pickAnim(id: string): Promise<void> {
    if (id === selectedAnim) return
    setSelectedAnim(id)
    await updateProfile({
      usernameAnimation: id as 'none' | 'shimmer' | 'rainbow' | 'pulse' | 'glitch' | 'neon',
    })
  }

  async function pickColor(hex: string | null): Promise<void> {
    if (hex === selectedColor) return
    setSelectedColor(hex)
    // Empty string clears server-side (PATCH /me treats it as reset).
    await updateProfile({ usernameColor: hex ?? '' })
  }

  async function pickSecondaryColor(hex: string | null): Promise<void> {
    if (hex === selectedColor2) return
    setSelectedColor2(hex)
    await updateProfile({ usernameColor2: hex })
  }

  async function toggleColorAnimated(next: boolean): Promise<void> {
    setColorAnimated(next)
    // Bi-colour mode is implicit in having a secondary colour. When
    // the toggle goes OFF we clear the secondary so it doesn't keep
    // applying as a pure-state side effect.
    if (!next) {
      setSelectedColor2(null)
      await updateProfile({ usernameColor2: null })
    } else if (!selectedColor2) {
      // Default secondary on enable — matches ScanVerse's behavior of
      // starting from violet so the preview shows the effect immediately.
      const defaultC2 = '#a855f7'
      setSelectedColor2(defaultC2)
      await updateProfile({ usernameColor2: defaultC2 })
    }
  }

  const fontDef = USERNAME_FONTS_BY_ID[selectedFont] ?? USERNAME_FONTS_BY_ID.default
  const baseAnimClass = selectedAnim !== 'none' ? `username-${selectedAnim}` : ''
  const animClass = `${baseAnimClass}${effectiveAnimated ? ' username-bi' : ''}`.trim()
  const previewColor = selectedColor || '#f0f0f5'
  const previewColor2 = selectedColor2 || '#a855f7'

  const previewLabel = useMemo(
    () => user?.displayName || user?.username || 'Aperçu',
    [user?.displayName, user?.username],
  )

  if (!user) return null

  return (
    <div
      className="p-4 sm:p-6 rounded-2xl"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <h2 className="font-semibold text-sm mb-1" style={{ color: '#f0f0f5' }}>
        Style du pseudo
      </h2>
      <p className="text-xs mb-5" style={{ color: '#9090a8' }}>
        Police + effet visuel appliqués à ton pseudo sur ta page de profil.
      </p>

      {/* Live preview — full pseudo with font + animation + colour
          composed together. Discord pattern: one preview card, not
          three separate previews per section. */}
      <div
        className="rounded-xl p-5 mb-5 text-center"
        style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span
          className={animClass}
          data-text={previewLabel}
          style={{
            display: 'inline-block',
            fontSize: '2rem',
            fontFamily: fontDef?.fontFamily,
            fontWeight: fontDef?.weight,
            color: previewColor,
            // CSS vars consumed by the .username-bi sweep keyframes.
            // Always set both — when bi mode is off the vars exist but
            // no animation class reads them, so they're a no-op.
            ['--uname-c1' as string]: previewColor,
            ['--uname-c2' as string]: previewColor2,
            letterSpacing: '-0.01em',
            position: 'relative',
          }}
        >
          {previewLabel}
        </span>
      </div>

      {/* ── Section: Police ───────────────────────────────────────── */}
      <h3
        className="text-xs font-mono uppercase tracking-wider mb-2.5"
        style={{ color: '#9090a8', letterSpacing: '0.08em' }}
      >
        Police
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
        {USERNAME_FONTS.map((f) => {
          const active = selectedFont === f.id
          return (
            <button
              key={f.id}
              onClick={() => void pickFont(f.id)}
              className="flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl transition-all active:scale-95"
              style={{
                background: active ? ACTIVE_TILE_BG : IDLE_TILE_BG,
                border: active ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                cursor: 'pointer',
              }}
            >
              <span
                className="text-base truncate w-full text-left"
                style={{
                  fontFamily: f.fontFamily,
                  fontWeight: f.weight,
                  color: active ? '#fff' : '#f0f0f5',
                }}
              >
                {previewLabel}
              </span>
              <span
                className="text-[10px] font-mono uppercase tracking-wider"
                style={{ color: active ? 'rgba(255,255,255,0.7)' : '#7a7a92' }}
              >
                {f.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Section: Animation ────────────────────────────────────── */}
      <h3
        className="text-xs font-mono uppercase tracking-wider mb-2.5"
        style={{ color: '#9090a8', letterSpacing: '0.08em' }}
      >
        Animation
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {USERNAME_ANIMATIONS.map((a) => {
          const active = selectedAnim === a.id
          return (
            <button
              key={a.id}
              onClick={() => void pickAnim(a.id)}
              title={a.description}
              className="flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl transition-all active:scale-95"
              style={{
                background: active ? ACTIVE_TILE_BG : IDLE_TILE_BG,
                border: active ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                cursor: 'pointer',
              }}
            >
              <span
                className={a.id !== 'none' ? `username-${a.id}` : ''}
                data-text="Pseudo"
                style={{
                  display: 'inline-block',
                  fontWeight: 800,
                  fontSize: '0.95rem',
                  color: active ? '#fff' : '#f0f0f5',
                  position: 'relative',
                }}
              >
                Pseudo
              </span>
              <span
                className="text-[10px] font-mono uppercase tracking-wider"
                style={{ color: active ? 'rgba(255,255,255,0.7)' : '#7a7a92' }}
              >
                {a.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Section: Couleur ────────────────────────────────────── */}
      <h3
        className="text-xs font-mono uppercase tracking-wider mb-2.5 mt-5"
        style={{ color: '#9090a8', letterSpacing: '0.08em' }}
      >
        Couleur
      </h3>
      <div className="flex flex-wrap items-center gap-2" style={{ padding: 6 }}>
        {/* Reset tile — explicit "no colour" slot leftmost, matching
            Discord / ScanVerse pattern. */}
        <button
          type="button"
          onClick={() => void pickColor(null)}
          title="Couleur par défaut"
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-transform active:scale-90"
          style={{
            background: IDLE_TILE_BG,
            border: selectedColor === null ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
            cursor: 'pointer',
          }}
        >
          <span style={{ color: '#9090a8', fontSize: 14, lineHeight: 1 }}>∅</span>
        </button>
        {USERNAME_COLOR_SWATCHES.map((hex) => {
          const active = selectedColor === hex
          return (
            <button
              key={hex}
              type="button"
              onClick={() => void pickColor(hex)}
              title={hex}
              className="w-9 h-9 rounded-lg flex items-center justify-center transition-transform active:scale-90"
              style={{
                background: hex,
                border: active ? ACTIVE_TILE_BORDER : '1px solid rgba(255,255,255,0.08)',
                cursor: 'pointer',
                boxShadow: active ? '0 0 0 2px rgba(99,102,241,0.25)' : 'none',
              }}
            >
              {active && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          )
        })}
        {/* Inline native colour picker — gives the user a custom
            HSV pipette without pulling in a heavy library. Wraps in
            a "Perso" pill so the picker is discoverable. */}
        <label
          className="flex items-center gap-2 px-2 py-1.5 rounded-full cursor-pointer"
          style={{
            background: '#0a0a0f',
            border: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
          title="Choisir une couleur personnalisée"
        >
          <span
            className="w-5 h-5 rounded-full"
            style={{
              background: selectedColor || '#ffffff',
              border: '1px solid rgba(255,255,255,0.2)',
            }}
          />
          <input
            type="color"
            value={selectedColor || '#ffffff'}
            onChange={(e) => void pickColor(e.target.value)}
            style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
          />
          <span
            className="text-xs font-mono uppercase pr-1"
            style={{ color: '#9090a8', letterSpacing: '1px' }}
          >
            Perso
          </span>
        </label>
      </div>

      {/* ── Couleur animée toggle + secondary picker ─────────────── */}
      <div className="mt-4">
        <label
          className="flex items-center justify-between p-3 rounded-xl"
          style={{
            background: '#0a0a0f',
            border: '1px solid rgba(255,255,255,0.06)',
            opacity: biColorAllowed ? 1 : 0.5,
            cursor: biColorAllowed ? 'pointer' : 'not-allowed',
          }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>
              Couleur animée
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#9090a8' }}>
              {biColorAllowed
                ? 'Transition entre deux couleurs sur ton pseudo.'
                : "Indisponible avec l'animation Arc-en-ciel (qui a déjà son propre dégradé)."}
            </div>
          </div>
          <input
            type="checkbox"
            checked={colorAnimated && biColorAllowed}
            disabled={!biColorAllowed}
            onChange={(e) => biColorAllowed && void toggleColorAnimated(e.target.checked)}
            className="w-5 h-5 flex-shrink-0 ml-3"
            style={{ accentColor: '#a855f7' }}
          />
        </label>

        {effectiveAnimated && (
          <div
            className="mt-3 p-3 rounded-xl flex items-center gap-3"
            style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <label
              className="w-9 h-9 rounded-lg cursor-pointer flex-shrink-0"
              style={{
                background: selectedColor2 || '#a855f7',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <input
                type="color"
                value={selectedColor2 || '#a855f7'}
                onChange={(e) => void pickSecondaryColor(e.target.value)}
                style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
              />
            </label>
            <div className="min-w-0 flex-1">
              <p
                className="text-xs font-mono uppercase tracking-wider"
                style={{ color: '#9090a8' }}
              >
                Couleur secondaire
              </p>
              <p
                className="text-xs font-mono mt-0.5 uppercase truncate"
                style={{ color: selectedColor2 || '#a855f7' }}
              >
                {selectedColor2 || '#a855f7'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * ProfileEntryAnimationPicker — direct port of ScanVerse's
 * `ProfileEntryAnimationPicker` (same `UsernameCustomisationPickers.jsx`
 * file). The 6 catalogue presets play once when a viewer lands on
 * `/community/profile/:id`. The preview card here REPLAYS the
 * animation every 2.8 s by remounting the inner node via a keyed
 * counter — same trick ScanVerse uses, otherwise the
 * `fill-mode: both` keyframes would freeze on the end state and the
 * user couldn't tell which effect is active.
 */
export function ProfileEntryAnimationPicker() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  const initial = user?.profileEntryAnimation ?? 'none'
  const [selected, setSelected] = useState<string>(initial)
  const [previewKey, setPreviewKey] = useState(0)

  useEffect(() => {
    setSelected(user?.profileEntryAnimation ?? 'none')
  }, [user?.id, user?.profileEntryAnimation])

  // Replay the entry animation in the preview every 2.8s so the user
  // sees what they're picking. Cleared on unmount.
  useEffect(() => {
    const id = setInterval(() => setPreviewKey((k) => k + 1), 2800)
    return () => clearInterval(id)
  }, [])

  async function pick(id: string): Promise<void> {
    if (id === selected) return
    setSelected(id)
    setPreviewKey((k) => k + 1)
    await updateProfile({ profileEntryAnimation: id })
  }

  const fontDef = USERNAME_FONTS_BY_ID[user?.usernameFont ?? 'default']
  const unameAnim = user?.usernameAnimation ?? 'none'
  const unameAnimDef = USERNAME_ANIMATIONS_BY_ID[unameAnim]
  const unameAnimClass = unameAnim !== 'none' ? `username-${unameAnimDef?.id}` : ''

  if (!user) return null

  return (
    <div
      className="p-4 sm:p-6 rounded-2xl mt-5"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <h2 className="font-semibold text-sm mb-1" style={{ color: '#f0f0f5' }}>
        Animation d'entrée du profil
      </h2>
      <p className="text-xs mb-5" style={{ color: '#9090a8' }}>
        Effet lorsqu'on arrive sur ton profil. Clique un preset pour le rejouer.
      </p>

      {/* Live preview — a miniature profile card. The animation class
          is keyed so React re-mounts the node, replaying the
          keyframes (looped every 2.8s by the effect above). Mirrors
          the real profile header. */}
      <div
        className="rounded-xl p-4 mb-4 overflow-hidden"
        style={{
          background: '#0a0a0f',
          border: '1px solid rgba(255,255,255,0.06)',
          minHeight: 96,
        }}
      >
        <div
          key={`${selected}-${previewKey}`}
          className={selected !== 'none' ? `sv-entry--${selected}` : ''}
        >
          <div className="flex items-center gap-3">
            {user.avatarPath ? (
              <img
                src={user.avatarPath}
                alt=""
                className="w-12 h-12 rounded-full flex-shrink-0 object-cover"
                style={{ border: '2px solid rgba(255,255,255,0.08)' }}
              />
            ) : (
              <div
                className="w-12 h-12 rounded-full flex-shrink-0 flex items-center justify-center text-base font-bold"
                style={{ background: '#6366f1', color: '#fff' }}
              >
                {(user.username ?? '?')[0]?.toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div
                className="font-extrabold text-base truncate"
                style={{
                  color: '#f0f0f5',
                  fontFamily: fontDef?.fontFamily,
                  fontWeight: fontDef?.weight ?? 800,
                }}
              >
                <span className={unameAnimClass} data-text={user.username}>
                  {user.displayName ?? user.username}
                </span>
              </div>
              <div className="text-xs font-mono" style={{ color: '#9090a8' }}>
                @{user.username}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PROFILE_ENTRY_ANIMATIONS.map((a) => {
          const active = selected === a.id
          return (
            <button
              key={a.id}
              onClick={() => void pick(a.id)}
              title={a.description}
              className="flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl transition-all active:scale-95"
              style={{
                background: active ? 'rgba(99,102,241,0.18)' : '#0a0a0f',
                border: active
                  ? '1px solid rgba(99,102,241,0.7)'
                  : '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
              }}
            >
              <span
                className="font-semibold text-sm"
                style={{ color: active ? '#fff' : '#f0f0f5' }}
              >
                {a.label}
              </span>
              <span
                className="text-[10px] font-mono uppercase tracking-wider truncate w-full text-left"
                style={{
                  color: active ? 'rgba(255,255,255,0.7)' : '#7a7a92',
                }}
              >
                {a.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
