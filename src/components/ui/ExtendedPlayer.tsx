/**
 * ExtendedPlayer — surface plein écran portrait reproduisant le HUD
 * étendu ScanVerse :
 *
 *   ┌────────────────────┐
 *   │   [plaque .webm]   │  ← background animé
 *   │  ┌──────────────┐  │
 *   │  │              │  │
 *   │  │   COVER      │  │  ← 240×240 environ, rounded, shadow
 *   │  │              │  │
 *   │  └──────────────┘  │
 *   │                    │
 *   │  Titre de la piste │
 *   │  Artiste           │
 *   │                    │
 *   │  ━━━━━●──────────  │  ← progress bar cliquable pour seek
 *   │  0:09         3:18 │
 *   │                    │
 *   │       (▶/⏸)        │  ← big circular play/pause accent
 *   │                    │
 *   │  🔊 ───●───── 70%  │  ← volume slider
 *   └────────────────────┘
 *
 * Au-dessus de tout : un bouton X minimise vers le MiniPlayer (toggle
 * extendedOpen=false dans MusicContext). Le track continue de jouer
 * dans les deux modes.
 *
 * La plaque animée du lecteur est rendue en background fixé (full
 * cover .webm). L'effet (PROFILE_EFFECTS) est composé par-dessus —
 * mêmes couches que dans le picker, juste à plus grande taille.
 */
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, Volume2, VolumeX, X, Music } from 'lucide-react'
import { useMusic } from '@/context/MusicContext'
import { PROFILE_EFFECTS_BY_ID, type ProfileEffect } from '@/config/profileCosmetics'

/**
 * Single layer of a profile effect, with timing logic that depends on
 * the source APNG's `plays` flag (parité ScanVerse MuteButton.jsx):
 *
 *   • plays = 1 (one-shot intro) :
 *       Mount once, play through `durationMs`, freeze on the last frame.
 *       Re-mounted only when `forceTick` changes — that happens on a
 *       long global cycle (max-part duration + 2.5 s rest) so the
 *       dramatic intro replays occasionally without overwhelming the card.
 *
 *   • plays = 0 (ambient loop) :
 *       Show for `durationMs` (one natural loop iteration), fade to
 *       opacity 0 for 5 s, remount to restart from frame 1, repeat.
 *       Without this gap the small ambient layer flickers non-stop
 *       under the bigger intro and gets visually noisy. The 5 s
 *       breathing room reproduces the Discord "respire entre chaque
 *       petite animation" feel.
 *
 * The trick for re-triggering an APNG from frame 1 is to change the
 * <img> element's `key` — React unmounts/remounts the node, which
 * forces the browser to restart the APNG decoder from frame 0.
 */
function ProfileEffectLayer({
  part,
  partIndex,
  forceTick,
}: {
  part: ProfileEffect['parts'][number]
  partIndex: number
  forceTick: number
}) {
  const PULSE_GAP_MS = 5000
  const [reKey, setReKey] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (part.plays !== 0) return // one-shot — handled by forceTick remount only
    let active = true
    let timer1: ReturnType<typeof setTimeout> | undefined
    let timer2: ReturnType<typeof setTimeout> | undefined
    function cycle(): void {
      if (!active) return
      setVisible(true)
      setReKey((k) => k + 1)
      timer1 = setTimeout(() => {
        if (!active) return
        setVisible(false)
        timer2 = setTimeout(() => {
          if (active) cycle()
        }, PULSE_GAP_MS)
      }, part.durationMs)
    }
    cycle()
    return () => {
      active = false
      if (timer1) clearTimeout(timer1)
      if (timer2) clearTimeout(timer2)
    }
  }, [part])

  // For one-shot parts, the `forceTick` value gets folded into the key
  // so a parent-driven big cycle remount still works.
  const imgKey = part.plays === 0 ? reKey : forceTick

  return (
    <img
      key={imgKey}
      src={part.file}
      alt=""
      aria-hidden
      draggable={false}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        maxWidth: 'none',
        maxHeight: 'none',
        zIndex: 1 + partIndex,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease-out',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    />
  )
}

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ExtendedPlayer() {
  const {
    currentTrack,
    isPlaying,
    isMuted,
    volume,
    currentTime,
    duration,
    progress,
    clipStart,
    clipEnd,
    togglePlay,
    toggleMute,
    setVolume,
    seekTo,
    extendedOpen,
    closeExtended,
  } = useMusic()

  // Affichage relatif au clip (parité ScanVerse) :
  //   - displayedTime = currentTime - clipStart, clampé à [0, clipDur]
  //   - displayedDuration = clipEnd - clipStart (ou duration totale
  //     si pas de clip défini)
  // Permet à l'user de voir "0:14 / 3:08" pour un clip de 3min08
  // démarré à 10s, au lieu de "0:24 / 3:18" du track entier.
  const hasClip = clipEnd != null && clipEnd > clipStart
  const displayedDuration = hasClip ? clipEnd - clipStart : duration
  const displayedTime = hasClip
    ? Math.max(0, Math.min(displayedDuration, currentTime - clipStart))
    : currentTime

  // Escape ferme la vue (UX modale standard).
  useEffect(() => {
    if (!extendedOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeExtended()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [extendedOpen, closeExtended])

  // Tick incrémenté à intervalle régulier pour re-monter les couches
  // one-shot (plays=1) et rejouer leur intro. Le cycle est calé sur la
  // durée de l'animation la plus longue + 2.5 s de pause, comme dans
  // ScanVerse MuteButton.jsx : sans tuning par effet, les courtes
  // animations (~3 s) avaient 6 s de temps mort par cycle, et les
  // longues (~14 s) étaient coupées en milieu de frame. Le hook reste
  // au-dessus de l'early-return sur `currentTrack` pour garder un ordre
  // d'appel stable entre renders.
  const REST_MS = 2500
  const [effectTick, setEffectTick] = useState(0)
  const effectId = currentTrack?.playerEffectId ?? null
  useEffect(() => {
    if (!effectId) return
    const fx = PROFILE_EFFECTS_BY_ID[effectId]
    const cycleMs = (fx?.durationMs || 4000) + REST_MS
    const id = window.setInterval(() => setEffectTick((t) => t + 1), cycleMs)
    return () => clearInterval(id)
  }, [effectId])

  if (!currentTrack) return null

  // L'ExtendedPlayer affiche UNIQUEMENT l'animation du lecteur étendu
  // (profile effect). La plaque animée du lecteur est réservée au
  // MiniPlayer compact — pattern ScanVerse "chaque surface a son
  // ornement propre".
  const effect = currentTrack.playerEffectId
    ? PROFILE_EFFECTS_BY_ID[currentTrack.playerEffectId]
    : null

  function onProgressClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    // Seek dans la fenêtre du clip : ratio 0..1 mappe vers
    // [clipStart, clipEnd] (ou [0, duration] sans clip).
    if (hasClip) {
      seekTo(clipStart + ratio * displayedDuration)
    } else {
      seekTo(ratio * duration)
    }
  }

  return (
    <AnimatePresence>
      {extendedOpen && (
        <motion.div
          // Ancrage bottom-right (même coin que le MiniPlayer) — pas de
          // backdrop fullscreen comme un modal classique. La surface
          // "remplace" le MiniPlayer visuellement. Compactée à 340×500
          // (vs 380×600 avant) pour ne plus envahir la moitié de l'écran.
          className="fixed z-[150] bottom-5 right-5 rounded-2xl overflow-hidden flex flex-col"
          style={{
            // Parité ScanVerse MuteButton.jsx : largeur 300px desktop
            // (max 360px), hauteur AUTO pilotée par le contenu — pas de
            // fixe à 620px qui faisait envahir la moitié de l'écran.
            // La carte fait naturellement ~520px (cover 300×300 + ~220
            // de contrôles), équivalente au ressenti compact ScanVerse.
            width: 'min(300px, calc(100vw - 24px))',
            maxWidth: 360,
            background: '#0a0a0f',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
            // transformOrigin bottom-right pour que l'animation
            // "émerge" du coin où le MiniPlayer disparaît, plutôt que
            // de zoomer depuis son centre. Parité avec la transition
            // visuelle ScanVerse : le mini collapse, l'expanded
            // grandit depuis la MÊME zone.
            transformOrigin: 'bottom right',
          }}
          // Parité ScanVerse (MuteButton.jsx) :
          //   • Ouverture : scale 0.88 + translateY 14px → 1/0 avec
          //     un easing à dépassement (`cubic-bezier(0.34, 1.56,
          //     0.64, 1)`) sur 220 ms. Le pic > 1 crée le petit
          //     "pop" de ressort qui donne du caractère à la HUD.
          //   • Fermeture : easing lisse SANS overshoot
          //     (`cubic-bezier(0.36, 0, 0.66, 1)`) sur 220 ms. Une
          //     fermeture bouncy se sentirait nerveuse / non
          //     intentionnelle ; une fermeture droite a l'air
          //     décidée.
          // Framer Motion accepte les points de contrôle de
          // cubic-bezier sous forme de tableau [x1, y1, x2, y2].
          initial={{ opacity: 0, scale: 0.88, y: 14 }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: { duration: 0.22, ease: [0.34, 1.56, 0.64, 1] },
          }}
          exit={{
            opacity: 0,
            scale: 0.88,
            y: 14,
            transition: { duration: 0.22, ease: [0.36, 0, 0.66, 1] },
          }}
        >
            {/* ── Contenu PRINCIPAL (z=10) ────────────────────────
                Cover edge-to-edge en haut, puis bloc contrôles padded.
                Parité ScanVerse : la cover prend TOUTE la largeur de
                la carte (pas de padding sur les côtés) et les contrôles
                vivent dans un bloc en dessous avec padding 14/16/16. */}
            <div className="relative" style={{ zIndex: 10 }}>
              {/* Cover — full-width, aspect-ratio 1/1, edge-to-edge.
                  Clic = collapse → MiniPlayer (parité ScanVerse où
                  l'album art lui-même ferme l'expanded view). */}
              <button
                type="button"
                onClick={closeExtended}
                aria-label="Réduire le lecteur"
                className="relative block w-full overflow-hidden p-0 cursor-pointer"
                style={{
                  aspectRatio: '1 / 1',
                }}
              >
                {currentTrack.albumArt ? (
                  <img
                    src={currentTrack.albumArt}
                    alt=""
                    draggable={false}
                    onError={(e) => {
                      // maxresdefault n'existe pas pour toutes les
                      // vidéos. Fallback sur mqdefault (320×180, vrai
                      // 16:9, toujours dispo) — pas hqdefault qui
                      // ramènerait les bandes noires.
                      const img = e.currentTarget
                      if (img.src.includes('maxresdefault')) {
                        img.src = img.src.replace('maxresdefault', 'mqdefault')
                      }
                    }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      // BYPASS Tailwind preflight `img { max-width:
                      // 100%; height: auto }` qui sinon override les
                      // dimensions et laisse l'image en hauteur native.
                      maxWidth: 'none',
                      maxHeight: 'none',
                    }}
                  />
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ background: 'var(--accent-gradient)' }}
                  >
                    <Music className="w-16 h-16 text-white/85" />
                  </div>
                )}
                {/* Fade vers le dark de la carte sous la cover —
                    parité ScanVerse, donne du contraste à la limite
                    cover/contrôles sans assombrir le haut. */}
                <div
                  aria-hidden
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background:
                      'linear-gradient(to bottom, transparent 50%, rgba(10,10,15,0.95) 100%)',
                  }}
                />
              </button>

              {/* Bloc contrôles — padding ScanVerse 14/16/16. */}
              <div style={{ padding: '14px 16px 16px' }}>
                {/* Title + artist — left-aligned. */}
                <div className="min-h-0">
                  <p
                    className="font-bold text-sm text-white truncate"
                    title={currentTrack.title}
                    style={{ textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}
                  >
                    {currentTrack.title}
                  </p>
                  {currentTrack.artist && (
                    <p
                      className="text-xs text-white/65 truncate mt-0.5"
                      style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}
                    >
                      {currentTrack.artist}
                    </p>
                  )}
                </div>

                {/* Progress bar — cliquable pour seek. Slim track 4px. */}
                <div
                  className="relative h-1 rounded-full cursor-pointer mt-3"
                  style={{ background: 'rgba(255,255,255,0.18)' }}
                  onClick={onProgressClick}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all"
                    style={{
                      width: `${progress * 100}%`,
                      background: 'var(--accent-primary)',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-white/70 mt-1">
                  <span>{fmt(displayedTime)}</span>
                  <span>{fmt(displayedDuration)}</span>
                </div>

                {/* Big play/pause — centré, taille modeste (parité
                    ScanVerse : 40 px, pas 64). Pop d'accent qui ne
                    domine pas la cover. */}
                <div className="flex justify-center mt-3">
                  <button
                    onClick={togglePlay}
                    aria-label={isPlaying ? 'Mettre en pause' : 'Lire'}
                    className="relative flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: '50%',
                      background: 'var(--accent-primary)',
                      color: '#fff',
                      boxShadow: '0 6px 18px -4px var(--accent-glow)',
                    }}
                  >
                    {isPlaying ? (
                      <Pause className="w-5 h-5 fill-current" />
                    ) : (
                      // Play icon visuellement décalé de 2px à droite pour
                      // compenser le triangle qui pèse plus à gauche.
                      <Play
                        className="w-5 h-5 fill-current"
                        style={{ marginLeft: 2 }}
                      />
                    )}
                  </button>
                </div>

                {/* Volume row — mute icon, slider, percentage */}
                <div className="flex items-center gap-2.5 mt-3">
                  <button
                    onClick={toggleMute}
                    aria-label={isMuted ? 'Activer le son' : 'Couper le son'}
                    className="text-white/70 hover:text-white transition-colors shrink-0"
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX className="w-4 h-4" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="flex-1 cursor-pointer"
                    style={{ accentColor: 'var(--accent-primary)', height: 4 }}
                    aria-label="Volume"
                  />
                  <span className="text-[10px] font-mono text-white/70 min-w-[28px] text-right">
                    {Math.round((isMuted ? 0 : volume) * 100)}%
                  </span>
                </div>
              </div>
            </div>

            {/* ── Animation du lecteur étendu (z=20, OVER everything) ──
                Parité ScanVerse MuteButton.jsx : l'effet est positionné
                ABSOLUTE inset:0 par-dessus le contenu (z=10), avec
                pointer-events:none pour laisser passer les clics aux
                contrôles dessous. Ça donne au lecteur ce rendu Discord
                où l'animation "habille" toute la HUD, cover comprise.
                Chaque part via <ProfileEffectLayer> respecte son
                propre timing :
                  • plays=1 → intro one-shot freezée, rejouée quand
                              `effectTick` change.
                  • plays=0 → ambient loop avec 5 s de gap entre cycles. */}
            {effect && effect.parts.length > 0 && (
              <div
                aria-hidden
                className="absolute inset-0 pointer-events-none"
                style={{ zIndex: 20 }}
              >
                {effect.parts.map((part) => (
                  <ProfileEffectLayer
                    key={part.index}
                    part={part}
                    partIndex={part.index}
                    forceTick={effectTick}
                  />
                ))}
              </div>
            )}

            {/* Bouton fermer — top-right, par-dessus l'effet (z=100). */}
            <button
              onClick={closeExtended}
              aria-label="Réduire le lecteur"
              className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full flex items-center justify-center text-white/85 hover:text-white hover:bg-black/40 transition-colors"
              style={{
                zIndex: 100,
                background: 'rgba(0,0,0,0.35)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
