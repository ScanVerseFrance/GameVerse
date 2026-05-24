/**
 * MiniPlayer — barre horizontale compacte bottom-right (parité
 * ScanVerse). Renvoie null tant que la MusicContext n'a pas de
 * `currentTrack` ; sinon affiche :
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [cover]  ♪  Titre de la piste — Artiste     ▶  🔊 ✕ │
 *   └──────────────────────────────────────────────────────┘
 *      (plaque .webm en background full cover)
 *
 *  - Cover thumbnail (44 px) à gauche, cliquable → openExtended
 *  - Icône Music indicative juste après
 *  - Titre + artiste truncate au milieu (flex-1), cliquable aussi
 *    pour ouvrir l'ExtendedPlayer
 *  - Bouton play/pause accent (36 px circulaire) à droite
 *  - Bouton mute toggle (juste l'icône, slider relégué à
 *    l'ExtendedPlayer pour économiser la place)
 *  - Bouton X pour fermer (stop) — petit, top-right
 *  - Barre de progression slim 2 px en bas (matérialise l'avancée
 *    sans cliquer)
 *
 * Compacte vs l'ancien card vertical : la HUD audio est désormais
 * conçue pour être "ambient" — l'user qui veut détailler ouvre
 * l'ExtendedPlayer.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, X, Music } from '@/lib/icons'
import { useMusic } from '@/context/MusicContext'
import { NAMEPLATES_BY_ID } from '@/config/profileCosmetics'

/**
 * Marquee — scrolling text qui défile horizontalement quand le
 * contenu dépasse son conteneur (parité ScanVerse MuteButton.jsx).
 *
 * Mesure le débordement après mount : si le texte est plus large que
 * le conteneur, on duplique le texte et on anime un translateX -50 %
 * en boucle. Sans débordement, on rend juste le texte une fois.
 *
 * L'animation est "scroll → pause → scroll" via les keyframes
 * `nx-marquee` (0-15 % statique, 15-85 % scroll, 85-100 % statique
 * sur la deuxième copie) — donne un rythme respirant au lieu d'un
 * scroll continu fatigant. Injectée inline via <style> pour rester
 * autonome sans toucher index.css.
 */
function Marquee({ text, style }: { text: string; style?: React.CSSProperties }) {
  const outerRef = useRef<HTMLSpanElement | null>(null)
  const singleRef = useRef<HTMLSpanElement | null>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    if (!outerRef.current || !singleRef.current) return
    setOverflow(singleRef.current.offsetWidth > outerRef.current.clientWidth + 2)
  }, [text])

  if (!overflow) {
    return (
      <span
        ref={outerRef}
        style={{ overflow: 'hidden', display: 'block', whiteSpace: 'nowrap', ...style }}
      >
        <span ref={singleRef}>{text}</span>
      </span>
    )
  }

  // Gap entre les deux copies — sans ça, le texte se collerait à
  // lui-même au moment du wrap.
  const GAP = 48
  return (
    <span ref={outerRef} style={{ overflow: 'hidden', display: 'block', ...style }}>
      <span
        style={{
          display: 'inline-flex',
          animation: 'nx-marquee 9s linear infinite',
          whiteSpace: 'nowrap',
        }}
      >
        <span ref={singleRef} style={{ flexShrink: 0, paddingRight: GAP }}>
          {text}
        </span>
        <span style={{ flexShrink: 0, paddingRight: GAP }}>{text}</span>
      </span>
    </span>
  )
}

const MARQUEE_KEYFRAMES = `
@keyframes nx-marquee {
  0%   { transform: translateX(0); }
  15%  { transform: translateX(0); }
  85%  { transform: translateX(-50%); }
  100% { transform: translateX(-50%); }
}
`

export function MiniPlayer() {
  const {
    currentTrack,
    isPlaying,
    isMuted,
    volume,
    progress,
    togglePlay,
    stop,
    toggleMute,
    setVolume,
    openExtended,
    extendedOpen,
  } = useMusic()

  // Popup volume slider — apparait au hover sur l'icône son (parité
  // ScanVerse MuteButton.jsx). Le délai de 200 ms sur leave laisse le
  // temps à l'user de glisser sa souris du bouton vers le slider sans
  // que le popup disparaisse pendant le transit.
  const [volHovered, setVolHovered] = useState(false)
  const volLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleVolEnter = useCallback(() => {
    if (volLeaveTimer.current) clearTimeout(volLeaveTimer.current)
    setVolHovered(true)
  }, [])
  const handleVolLeave = useCallback(() => {
    volLeaveTimer.current = setTimeout(() => setVolHovered(false), 200)
  }, [])

  // Masque le MiniPlayer pendant que l'ExtendedPlayer est ouvert —
  // les deux surfaces partagent le coin bottom-right et la HUD étendue
  // prend le relais visuel.
  if (!currentTrack || extendedOpen) return null

  const plaque = currentTrack.playerPlaqueId
    ? NAMEPLATES_BY_ID[currentTrack.playerPlaqueId]
    : null

  return (
    <>
    {/* Keyframes du marquee injectées une seule fois — inline pour
        garder le composant autonome (pas de dépendance sur
        index.css). React déduplique automatiquement les <style> au
        même contenu via le navigateur. */}
    <style>{MARQUEE_KEYFRAMES}</style>
    <div
      // Anchor bottom-right comme ScanVerse. Le z-stack :
      // CloudSaveToast 120 > MiniPlayer 95 > MobileBottomNav 90.
      //
      // ATTENTION : ce conteneur extérieur n'a PAS d'overflow-hidden.
      // Le clip des coins arrondis (pour la plaque vidéo) vit sur la
      // carte intérieure ci-dessous. Pourquoi ? Le popup de volume au
      // hover doit pouvoir SORTIR vers le haut sans être tronqué — un
      // overflow-hidden ici cropait le popup à 64 px de haut.
      // Dimensions ScanVerse MuteButton.jsx : la HUD compact est
      // naturellement sizée (pas de width/height fixe), juste un
      // padding 8/12 autour du contenu. Du coup elle adapte sa
      // largeur au titre (avec un maxWidth marquee 130 px qui empêche
      // les longs titres de la faire exploser) et reste fine en
      // hauteur (~46-50 px selon le contenu). Avant on forçait
      // 360×64 → trop massif.
      className="fixed z-[95] bottom-5 right-5"
      role="status"
      aria-label="Lecteur de musique de profil"
    >
      {/* ── Carte intérieure : clip + bg + bordure ──
          Tout le contenu (plaque, row, progress) vit ici. Le clip
          des coins arrondis n'affecte que les éléments enfants ;
          le popup de volume, rendu plus bas comme SIBLING de cette
          carte, échappe au clip. */}
      <div
        className="relative rounded-xl shadow-2xl overflow-hidden"
        style={{
          // Plus de w-full / h-full : la carte se dimensionne sur le
          // contenu. Largeur capée à 320 px max pour empêcher les
          // longs titres + plaque + contrôles de faire exploser la
          // HUD ; hauteur libre, déterminée par les 36 px de la cover
          // + padding vertical → ~52 px (parité ScanVerse).
          maxWidth: 320,
          background: 'rgba(12, 12, 18, 0.95)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
      {/* Plaque animée — full cover background. Voile sombre par
          dessus pour la lisibilité du titre + des icônes. */}
      {plaque && (
        <>
          <video
            src={plaque.file}
            autoPlay
            loop
            muted
            playsInline
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              maxWidth: 'none',
              maxHeight: 'none',
              zIndex: 0,
            }}
          />
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              zIndex: 1,
              background:
                plaque.gradientCss ??
                'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)',
            }}
          />
        </>
      )}

      {/* Row principale — padding 8/12 (parité ScanVerse), gap 8 px */}
      <div
        className="relative flex items-center"
        style={{ zIndex: 10, padding: '8px 12px', gap: 8 }}
      >
        {/* Cover thumbnail — 36×36 (parité ScanVerse, vs 48×48
            avant). Plus discret, garde la HUD légère. */}
        <button
          type="button"
          onClick={openExtended}
          aria-label="Agrandir le lecteur"
          className="group relative shrink-0 rounded-md overflow-hidden cursor-pointer transition-transform hover:scale-105 active:scale-95"
          style={{ width: 36, height: 36 }}
        >
          {currentTrack.albumArt ? (
            <img
              src={currentTrack.albumArt}
              alt=""
              draggable={false}
              onError={(e) => {
                // Fallback maxresdefault → mqdefault si pas dispo
                // (vidéos non-HD). mqdefault est aussi 16:9 sans
                // bandes noires.
                const img = e.currentTarget
                if (img.src.includes('maxresdefault')) {
                  img.src = img.src.replace('maxresdefault', 'mqdefault')
                }
              }}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                maxWidth: 'none',
                maxHeight: 'none',
              }}
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center"
              style={{ background: 'var(--accent-gradient)' }}
            >
              <Music className="w-4 h-4 text-white/90" />
            </div>
          )}
        </button>

        {/* Music indicator + titre marquee — cliquable lui aussi
            pour ouvrir l'ExtendedPlayer. Le titre est capé à 130 px
            de maxWidth ; au-delà il défile via le composant <Marquee>
            (parité ScanVerse). Plus de sous-titre artiste/chaîne
            (retiré pour resserrer la HUD à une seule ligne). */}
        <button
          type="button"
          onClick={openExtended}
          className="min-w-0 flex items-center gap-1.5 text-left cursor-pointer"
          style={{ maxWidth: 130 }}
          aria-label="Agrandir le lecteur"
        >
          <Music
            className="w-3 h-3 shrink-0 text-accent-primary"
            aria-hidden
          />
          <Marquee
            text={currentTrack.title || 'Piste en cours'}
            style={{
              maxWidth: 110,
              fontSize: 12,
              fontWeight: 600,
              color: '#f0f0f5',
              textShadow: plaque ? '0 1px 2px rgba(0,0,0,0.7)' : undefined,
              fontFamily: 'inherit',
            }}
          />
        </button>

        {/* Play / pause — bouton accent 28 px (vs 32 avant) pour
            matcher la compacité ScanVerse. */}
        <button
          onClick={togglePlay}
          aria-label={isPlaying ? 'Mettre en pause' : 'Lire'}
          className="shrink-0 flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'var(--accent-primary)',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            boxShadow: '0 4px 12px -2px var(--accent-glow)',
          }}
        >
          {isPlaying ? (
            <Pause className="w-3 h-3 fill-current" />
          ) : (
            // Décalage +1px pour compenser le centre optique du triangle.
            <Play
              className="w-3 h-3 fill-current"
              style={{ marginLeft: 1 }}
            />
          )}
        </button>

        {/* Mute toggle — le bouton click toggle mute ; le slider
            volume vit OUTSIDE de cette carte (en sibling, juste
            avant la fermeture du wrapper externe) pour pouvoir
            sortir vers le haut sans être tronqué par
            l'overflow-hidden de la carte. Les handlers
            enter/leave sont sur le wrapper du bouton ET sur le
            popup → glisser de l'un à l'autre garde le popup
            ouvert grâce au délai de 200 ms. */}
        <div
          className="relative shrink-0 flex items-center"
          onMouseEnter={handleVolEnter}
          onMouseLeave={handleVolLeave}
        >
          <button
            onClick={toggleMute}
            aria-label={isMuted ? 'Activer le son' : 'Couper le son'}
            className="p-0.5 transition-colors flex items-center"
            style={{
              color: plaque ? 'rgba(255,255,255,0.85)' : '#9090a8',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {isMuted ? (
              <VolumeX className="w-3 h-3" />
            ) : (
              <Volume2 className="w-3 h-3" />
            )}
          </button>
        </div>

        {/* Close — petit X discret. */}
        <button
          onClick={stop}
          aria-label="Fermer le lecteur"
          className="shrink-0 p-0.5 transition-colors hover:text-white flex items-center"
          style={{
            color: plaque ? 'rgba(255,255,255,0.65)' : '#7a7a92',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Progress bar — 2 px tout en bas, full width. Pas cliquable
          en mode compact (seek vit dans l'ExtendedPlayer). */}
      <div
        aria-hidden
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: 2,
          background: 'rgba(255,255,255,0.15)',
          zIndex: 10,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progress * 100}%`,
            background: 'var(--accent-primary)',
            transition: 'width 0.1s linear',
          }}
        />
      </div>
      </div>{/* /carte intérieure (clip + bg) */}

      {/* ── Popup volume en SIBLING de la carte ──
          Rendu en dehors de l'overflow-hidden de la carte intérieure
          pour pouvoir s'étendre vers le haut sans être tronqué.
          Position absolute relative au wrapper extérieur (qui n'a pas
          d'overflow-hidden) :
            • bottom: 100% + 8 → 8 px au-dessus du wrapper (donc
              au-dessus du player), avec un petit gap pour respirer.
            • right: 38 → aligne le bord droit du popup avec le bord
              droit du bouton mute (pr-2.5 = 10 + bouton close ≈ 20 +
              gap-2 = 8 → 38 px depuis la droite du player).
          Les handlers enter/leave sont aussi sur le popup pour que
          déplacer la souris du bouton mute vers le slider ne ferme
          pas le popup. */}
      {volHovered && (
        <div
          onMouseEnter={handleVolEnter}
          onMouseLeave={handleVolLeave}
          role="presentation"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 38,
            background: 'rgba(10,10,15,0.97)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            minWidth: 40,
            zIndex: 100,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: '#9090a8',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
            }}
          >
            {isMuted ? 'Muet' : `${Math.round(volume * 100)}%`}
          </span>
          {/* Slider VERTICAL — `writing-mode: vertical-lr` +
              `direction: rtl` fait pivoter l'input range pour qu'il
              pointe vers le haut (0% en bas, 100% en haut). Astuce
              CSS standard, supportée par Chromium / Electron. */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              setVolume(v)
              // Move le mute auto quand on remet du volume —
              // évite que l'user remonte le slider mais n'entende
              // rien parce que le mute est encore on.
              if (v > 0 && isMuted) toggleMute()
            }}
            style={{
              writingMode: 'vertical-lr' as const,
              direction: 'rtl',
              width: 4,
              height: 80,
              accentColor: 'var(--accent-primary)',
              cursor: 'pointer',
            }}
            aria-label="Volume"
          />
        </div>
      )}
    </div>
    </>
  )
}
