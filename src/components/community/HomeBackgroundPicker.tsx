/**
 * HomeBackgroundPicker + BackgroundColorPicker — pickers 1×1
 * de ScanVerse Settings → Personnalisation :
 *
 *   • Couleur de fond  : couleur primaire + secondaire pour le
 *     "couleur animée" cycle + sync avec accent + custom hex
 *   • Fond animé de la page d'accueil : 7 presets (Aucun / Rayons
 *     lumineux / Vagues / Éther / Voile / Lignes / Courbes)
 *
 * Persistance : useSettingsStore (localStorage). Pas de PATCH cloud
 * — c'est une préférence locale du launcher, pas un cosmétique
 * partagé entre amis.
 */
import type { HomeBackgroundAnimation } from '@/stores/settings.store'
import { useSettingsStore } from '@/stores/settings.store'

const ACTIVE_TILE_BG = 'rgba(99, 102, 241, 0.18)'
const ACTIVE_TILE_BORDER = '1px solid rgba(99, 102, 241, 0.7)'
const IDLE_TILE_BG = '#0a0a0f'
const IDLE_TILE_BORDER = '1px solid rgba(255,255,255,0.06)'

const HOME_BG_PRESETS: Array<{ id: HomeBackgroundAnimation; label: string; emoji: string }> = [
  { id: 'none',   label: 'Aucun',           emoji: '∅' },
  { id: 'rays',   label: 'Rayons lumineux', emoji: '🌟' },
  { id: 'waves',  label: 'Vagues de lignes', emoji: '🌊' },
  { id: 'ether',  label: 'Éther liquide',   emoji: '💧' },
  { id: 'veil',   label: 'Voile sombre',    emoji: '🌑' },
  { id: 'flow',   label: 'Lignes flottantes', emoji: '🪶' },
  { id: 'curves', label: 'Courbes colorées', emoji: '🎨' },
]

const BG_SWATCHES = [
  '#F59E0B', '#EF4444', '#10B981', '#3B82F6',
  '#8B5CF6', '#EC4899', '#06B6D4', '#F472B6',
]

export function BackgroundColorPicker() {
  const bgColor = useSettingsStore((s) => s.backgroundColor)
  const setBgColor = useSettingsStore((s) => s.setBackgroundColor)
  const bgColor2 = useSettingsStore((s) => s.bgColorSecondary)
  const setBgColor2 = useSettingsStore((s) => s.setBgColorSecondary)
  const sync = useSettingsStore((s) => s.bgSyncWithAccent)
  const setSync = useSettingsStore((s) => s.setBgSyncWithAccent)
  const animated = useSettingsStore((s) => s.bgColorAnimated)
  const setAnimated = useSettingsStore((s) => s.setBgColorAnimated)

  return (
    <div
      className="p-4 sm:p-6 rounded-2xl"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <h2 className="font-semibold text-sm mb-1" style={{ color: '#f0f0f5' }}>
        Couleur de fond
      </h2>
      <p className="text-xs mb-4" style={{ color: '#9090a8' }}>
        Couleur principale appliquée au fond animé de la page d'accueil.
      </p>

      {/* Toggles : Couleur animée + Sync avec accent */}
      <div className="flex flex-col gap-2 mb-4">
        <label
          className="flex items-center justify-between p-3 rounded-xl cursor-pointer"
          style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>
              Couleur animée
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#9090a8' }}>
              Transition entre 2 couleurs sur le fond.
            </div>
          </div>
          <input
            type="checkbox"
            checked={animated}
            onChange={(e) => setAnimated(e.target.checked)}
            className="w-5 h-5 flex-shrink-0 ml-3"
            style={{ accentColor: '#a855f7' }}
          />
        </label>

        <label
          className="flex items-center justify-between p-3 rounded-xl cursor-pointer"
          style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>
              Synchroniser avec l'accent
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#9090a8' }}>
              Le fond suit la couleur d'accentuation du thème actif.
            </div>
          </div>
          <input
            type="checkbox"
            checked={sync}
            onChange={(e) => setSync(e.target.checked)}
            className="w-5 h-5 flex-shrink-0 ml-3"
            style={{ accentColor: '#a855f7' }}
          />
        </label>
      </div>

      {!sync && (
        <>
          <p
            className="text-[10px] font-mono uppercase tracking-wider mt-2 mb-2"
            style={{ color: '#9090a8' }}
          >
            Couleur personnalisée
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button
              type="button"
              onClick={() => setBgColor(null)}
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{
                background: IDLE_TILE_BG,
                border: bgColor === null ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                cursor: 'pointer',
              }}
              title="Couleur par défaut"
            >
              <span style={{ color: '#9090a8' }}>∅</span>
            </button>
            {BG_SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => setBgColor(hex)}
                className="w-9 h-9 rounded-lg"
                style={{
                  background: hex,
                  border: bgColor === hex ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                  cursor: 'pointer',
                }}
              />
            ))}
            <label
              className="flex items-center gap-2 px-2 py-1.5 rounded-full cursor-pointer"
              style={{
                background: '#0a0a0f',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <span
                className="w-5 h-5 rounded-full"
                style={{
                  background: bgColor || '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
              />
              <input
                type="color"
                value={bgColor || '#ffffff'}
                onChange={(e) => setBgColor(e.target.value)}
                style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
              />
              <span
                className="text-xs font-mono uppercase pr-1"
                style={{ color: '#9090a8' }}
              >
                {bgColor || '#F59E0B'}
              </span>
            </label>
          </div>

          {animated && (
            <>
              <p
                className="text-[10px] font-mono uppercase tracking-wider mt-3 mb-2"
                style={{ color: '#9090a8' }}
              >
                Couleur secondaire
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {BG_SWATCHES.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setBgColor2(hex)}
                    className="w-9 h-9 rounded-lg"
                    style={{
                      background: hex,
                      border:
                        bgColor2 === hex ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                      cursor: 'pointer',
                    }}
                  />
                ))}
                <label
                  className="flex items-center gap-2 px-2 py-1.5 rounded-full cursor-pointer"
                  style={{
                    background: '#0a0a0f',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <span
                    className="w-5 h-5 rounded-full"
                    style={{
                      background: bgColor2 || '#a855f7',
                      border: '1px solid rgba(255,255,255,0.2)',
                    }}
                  />
                  <input
                    type="color"
                    value={bgColor2 || '#a855f7'}
                    onChange={(e) => setBgColor2(e.target.value)}
                    style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
                  />
                </label>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

export function HomeBackgroundPicker() {
  const anim = useSettingsStore((s) => s.homeBackgroundAnimation)
  const setAnim = useSettingsStore((s) => s.setHomeBackgroundAnimation)

  return (
    <div
      className="p-4 sm:p-6 rounded-2xl mt-5"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <h2 className="font-semibold text-sm mb-1" style={{ color: '#f0f0f5' }}>
        Fond animé de la page d'accueil
      </h2>
      <p className="text-xs mb-4" style={{ color: '#9090a8' }}>
        Choisissez l'animation affichée en arrière-plan sur la page d'accueil.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {HOME_BG_PRESETS.map((p) => {
          const active = anim === p.id
          return (
            <button
              key={p.id}
              onClick={() => setAnim(p.id)}
              title={p.label}
              className="relative overflow-hidden rounded-xl transition-all active:scale-95"
              style={{
                background: active ? ACTIVE_TILE_BG : IDLE_TILE_BG,
                border: active ? ACTIVE_TILE_BORDER : IDLE_TILE_BORDER,
                cursor: 'pointer',
                aspectRatio: '5 / 3',
              }}
            >
              {/* Mini-preview : on rend la classe home-bg--<id>
                  dans une div interne pour voir l'effet en
                  miniature. */}
              {p.id !== 'none' && (
                <div
                  aria-hidden
                  className={`absolute inset-0 home-bg home-bg--${p.id}`}
                  style={{
                    ['--bg-accent' as string]: 'rgba(168,85,247,0.32)',
                    ['--bg-accent-2' as string]: 'rgba(236,72,153,0.28)',
                    position: 'absolute',
                  }}
                />
              )}
              <div
                className="absolute inset-x-0 bottom-0 px-2 py-1.5 flex items-center justify-center gap-1.5"
                style={{
                  background:
                    'linear-gradient(to top, rgba(10,10,15,0.95), transparent)',
                }}
              >
                <span aria-hidden style={{ fontSize: 13 }}>
                  {p.emoji}
                </span>
                <span
                  className="text-[11px] font-mono uppercase tracking-wider"
                  style={{ color: active ? '#fff' : '#cfcfdb' }}
                >
                  {p.label}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
