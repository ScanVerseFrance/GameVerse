/**
 * useLocalPreview — lecture locale d'un extrait audio/YouTube SANS
 * passer par le MusicContext global (donc sans déclencher le
 * MiniPlayer global). Utilisé par ProfileMusicPicker pour le bouton
 * "Prévisualiser la sélection".
 *
 * Pattern ScanVerse → `profileAudioRef` + `setIsPreviewing` :
 *   - L'élément audio (ou l'iframe YT) vit le temps de la preview puis
 *     est détruit dès qu'on clique "Arrêter".
 *   - Un setTimeout `(clipEnd - clipStart) * 1000` ms ferme la preview
 *     à la fin de l'extrait — pas besoin d'écouter l'événement 'ended'
 *     qui ne fire que sur le bout du fichier complet.
 *   - `previewTime` est mis à jour à 250 ms d'intervalle pour
 *     l'aiguille du DualRangeSlider.
 *
 * Deux sources :
 *   - kind='audio' : Blob (fichier non-enregistré) ou relativePath
 *     (fichier persisté) → HTMLAudioElement.
 *   - kind='youtube' : video ID YouTube → iframe hidden YT IFrame
 *     Player (charge l'API lazily si pas déjà loadée par MusicContext).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface YTLikePlayer {
  playVideo: () => void
  pauseVideo: () => void
  stopVideo: () => void
  seekTo: (s: number, allowSeekAhead: boolean) => void
  getCurrentTime: () => number
  getDuration: () => number
  destroy: () => void
}

interface YTLikeNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string
      playerVars?: Record<string, unknown>
      events?: { onReady?: (e: { target: YTLikePlayer }) => void; onError?: () => void }
    },
  ) => YTLikePlayer
}

// MusicContext declare déjà `window.YT` au global ; on relit la même
// référence via un cast structurel (les deux types décrivent la même
// API IFrame YT donc le cast est sûr) plutôt que de re-déclarer pour
// éviter le clash "Subsequent property declarations must have the
// same type".
let ytApiPromise: Promise<YTLikeNamespace> | null = null
function loadYTApi(): Promise<YTLikeNamespace> {
  if (ytApiPromise) return ytApiPromise
  ytApiPromise = new Promise<YTLikeNamespace>((resolve) => {
    if (typeof window === 'undefined') return
    const w = window as unknown as {
      YT?: YTLikeNamespace
      onYouTubeIframeAPIReady?: () => void
    }
    if (w.YT?.Player) {
      resolve(w.YT)
      return
    }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    tag.async = true
    w.onYouTubeIframeAPIReady = () => {
      if (w.YT) resolve(w.YT)
    }
    document.head.appendChild(tag)
  })
  return ytApiPromise
}

export type PreviewSource =
  | { kind: 'audio-blob'; blob: Blob }
  | { kind: 'audio-path'; relativePath: string }
  | { kind: 'youtube'; videoId: string }

interface UseLocalPreviewReturn {
  /** True dès qu'on a lancé la preview, false à la fin / sur stop. */
  previewing: boolean
  /** Position courante de la lecture (en secondes), null tant qu'on
   *  preview pas. Le DualRangeSlider l'utilise pour son aiguille. */
  previewTime: number | null
  /** Durée totale de la source de preview courante (en secondes),
   *  0 tant que le metadata n'est pas chargé. Utilisé par le picker
   *  pour ajuster le max du slider à la vraie longueur YouTube /
   *  audio (au lieu du DEFAULT_DURATION de 5 min). */
  previewDuration: number
  /** Démarre une preview entre `start` et `end` (secondes). Tear
   *  down implicite de toute preview précédente. */
  start: (source: PreviewSource, start: number, end: number) => Promise<void>
  /** Arrête la preview courante — destructive (l'audio / iframe est
   *  détruit, pas juste paused). */
  stop: () => void
}

export function useLocalPreview(): UseLocalPreviewReturn {
  const [previewing, setPreviewing] = useState(false)
  const [previewTime, setPreviewTime] = useState<number | null>(null)
  const [previewDuration, setPreviewDuration] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ytPlayerRef = useRef<YTLikePlayer | null>(null)
  const ytContainerRef = useRef<HTMLDivElement | null>(null)
  // ObjectURL créé depuis un Blob — doit être revoke sur stop pour
  // ne pas leak la mémoire.
  const objectUrlRef = useRef<string | null>(null)
  // Timeout qui ferme la preview à la fin de l'extrait.
  const stopTimerRef = useRef<number | null>(null)
  // Ticker qui pousse `previewTime` à 250 ms d'intervalle pour
  // l'aiguille du slider.
  const tickerRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (tickerRef.current) {
      clearInterval(tickerRef.current)
      tickerRef.current = null
    }
    if (audioRef.current) {
      try {
        audioRef.current.pause()
        audioRef.current.src = ''
        if (audioRef.current.parentElement) {
          audioRef.current.parentElement.removeChild(audioRef.current)
        }
      } catch {
        /* swallow */
      }
      audioRef.current = null
    }
    if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.stopVideo()
        ytPlayerRef.current.destroy()
      } catch {
        /* swallow */
      }
      ytPlayerRef.current = null
    }
    if (ytContainerRef.current?.parentElement) {
      ytContainerRef.current.parentElement.removeChild(ytContainerRef.current)
    }
    ytContainerRef.current = null
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current)
      } catch {
        /* swallow */
      }
      objectUrlRef.current = null
    }
    setPreviewing(false)
    setPreviewTime(null)
    setPreviewDuration(0)
  }, [])

  const start = useCallback(
    async (source: PreviewSource, clipStart: number, clipEnd: number): Promise<void> => {
      // Nettoie toute preview en cours avant d'en lancer une autre.
      stop()
      const dur = Math.max(0.5, clipEnd - clipStart)

      // Auto-stop à la fin de l'extrait. Plus fiable que d'écouter
      // l'événement 'ended' du fichier (qui ne fire qu'à la fin du
      // FICHIER complet, pas à la fin de l'extrait).
      const startStopTimer = () => {
        stopTimerRef.current = window.setTimeout(stop, dur * 1000)
      }

      if (source.kind === 'audio-blob' || source.kind === 'audio-path') {
        const audio = document.createElement('audio')
        audio.preload = 'auto'
        // Attache au body (hors viewport) — sinon Chromium dans
        // Electron peut refuser de driver un <audio> détaché.
        audio.style.position = 'fixed'
        audio.style.left = '-9999px'
        audio.style.top = '-9999px'
        audio.style.pointerEvents = 'none'
        document.body.appendChild(audio)
        audioRef.current = audio

        if (source.kind === 'audio-blob') {
          const url = URL.createObjectURL(source.blob)
          objectUrlRef.current = url
          audio.src = url
        } else {
          // Charge les bytes via l'IPC main, wrap en Blob+URL.
          const res = await window.nexus.music.loadAudio(source.relativePath)
          if (!res.ok) {
            stop()
            return
          }
          const blob = new Blob([new Uint8Array(res.bytes)], { type: 'audio/*' })
          const url = URL.createObjectURL(blob)
          objectUrlRef.current = url
          audio.src = url
        }

        audio.addEventListener('loadedmetadata', () => {
          if (!isNaN(audio.duration) && audio.duration > 0) {
            setPreviewDuration(audio.duration)
          }
          audio.currentTime = clipStart
          audio.play().catch((err) => {
            console.warn('[useLocalPreview] audio.play rejected:', err)
            stop()
          })
        })
        audio.addEventListener('timeupdate', () => {
          setPreviewTime(audio.currentTime)
        })
        audio.addEventListener('error', () => stop())

        setPreviewing(true)
        startStopTimer()
        return
      }

      // YouTube — iframe caché 1×1 px hors viewport, contrôlée via
      // l'IFrame API. Mêmes flags que le player du MusicContext (no
      // controls, no related, origin set).
      const container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.top = '-9999px'
      container.style.width = '1px'
      container.style.height = '1px'
      container.style.opacity = '0'
      container.style.pointerEvents = 'none'
      document.body.appendChild(container)
      ytContainerRef.current = container

      const YT = await loadYTApi()
      ytPlayerRef.current = new YT.Player(container, {
        videoId: source.videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          start: Math.floor(clipStart),
          end: Math.floor(clipEnd),
          origin: typeof location !== 'undefined' ? location.origin : undefined,
        },
        events: {
          onReady: (e) => {
            try {
              // Lit la vraie durée du clip YT — onReady fire après le
              // chargement des métadonnées donc getDuration() est sûr.
              try {
                const d = e.target.getDuration()
                if (d > 0) setPreviewDuration(d)
              } catch {
                /* ignore */
              }
              e.target.seekTo(clipStart, true)
              e.target.playVideo()
              // Ticker — getCurrentTime n'a pas d'event timeupdate
              // côté IFrame API, on poll à 250 ms.
              tickerRef.current = window.setInterval(() => {
                try {
                  setPreviewTime(e.target.getCurrentTime())
                } catch {
                  /* ignore */
                }
              }, 250)
            } catch (err) {
              console.warn('[useLocalPreview] YT onReady threw:', err)
              stop()
            }
          },
          onError: () => stop(),
        },
      })
      setPreviewing(true)
      startStopTimer()
    },
    [stop],
  )

  // Cleanup au démontage du composant qui consomme le hook.
  useEffect(() => {
    return () => stop()
  }, [stop])

  return { previewing, previewTime, previewDuration, start, stop }
}
