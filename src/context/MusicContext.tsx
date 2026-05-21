/**
 * MusicContext — global profile-music player.
 *
 * Direct port of ScanVerse's `frontend/src/context/MusicContext.jsx`
 * adapted to a launcher reality: instead of an HTMLAudioElement with
 * a direct .mp3 URL (ScanVerse hosts the audio), we drive a hidden
 * YouTube IFrame Player. That way the user can paste any
 * `youtube.com/watch?v=…` or `youtu.be/…` URL in
 * Settings → Personnalisation → Musique de profil and the launcher
 * decodes it transparently — no extra cloud service, no ytdl-core
 * binary dependency, fully legal (uses the official IFrame API).
 *
 * The MiniPlayer (bottom-right Spotify-style card) consumes this
 * context. The profile page auto-starts the user's track on mount
 * via `useMusic().playUrl(profileMusicUrl, …)` and stops on unmount.
 *
 * Autoplay quirks: Chrome blocks `play()` until the user has
 * interacted with the page. The IFrame Player handles this nicely
 * — `playVideo()` returns immediately but the actual playback waits
 * for a user gesture if autoplay is blocked. The MiniPlayer's
 * play/pause button gives the user that gesture if needed.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/** Parse `youtube.com/watch?v=ID`, `youtu.be/ID`, `/embed/ID` and
 *  `/shorts/ID` into the bare video id. Returns null for anything
 *  the launcher doesn't recognise — caller is expected to surface
 *  a friendly "URL non reconnue" rather than crash. */
export function extractYouTubeId(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\/+/, '').split(/[/?#]/)[0]
      return id || null
    }
    const v = u.searchParams.get('v')
    if (v) return v
    const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)
    if (m) return m[1]
  } catch {
    /* not a URL */
  }
  return null
}

export interface PlayingTrack {
  /** Discriminator: which playback backend owns this track.
   *  - 'youtube' → MusicContext drives a hidden YT IFrame Player.
   *  - 'audio'   → MusicContext drives a hidden <audio> element loaded
   *               from a user-uploaded file (stored under userData/
   *               profile-audio/). */
  kind: 'youtube' | 'audio'
  /** Bare YouTube id (extracted from the user's URL). Empty string
   *  for kind='audio' (no video id involved). */
  videoId: string
  /** For kind='audio', the relative path in userData/profile-audio/
   *  that the file was loaded from. Null for kind='youtube'. */
  audioPath: string | null
  /** Resolved metadata for the MiniPlayer card. */
  title: string
  artist: string | null
  /** Auto-derived from YouTube's thumbnail server, or the user's
   *  custom cover for audio tracks (null = generic icon placeholder). */
  albumArt: string
  /** Nameplate id of the profile that owns this track — rendered as
   *  the animated .webm background behind the expanded player. Lets
   *  the player surface change vibe per profile visited, matching
   *  the ScanVerse "musique de profil" UX. */
  playerPlaqueId?: string | null
  /** Profile-effect id rendered as multi-layer overlay behind the
   *  expanded player. Same source as the profile cosmetics catalogue
   *  but persisted on the music row (independent of the profile-card
   *  effect). */
  playerEffectId?: string | null
}

interface MusicContextValue {
  currentTrack: PlayingTrack | null
  isPlaying: boolean
  isMuted: boolean
  /** 0..1, persisted in localStorage. */
  volume: number
  /** Seconds elapsed since the track started (absolute, includes
   *  the clipStart offset). */
  currentTime: number
  /** Total duration in seconds (resolved once the YT player reports). */
  duration: number
  /** Derived 0..1 progress, relative to the clip window if any. */
  progress: number
  /** Clip start offset (seconds). 0 = pas de clip / clip qui démarre
   *  au début. Permet aux consumers d'afficher le temps relatif
   *  (currentTime - clipStart) au lieu du temps absolu. Pattern
   *  ScanVerse : la UI montre la durée du clip (clipEnd - clipStart),
   *  pas la durée totale de la track. */
  clipStart: number
  /** Clip end (seconds). null = pas de clip / lecture jusqu'à la fin. */
  clipEnd: number | null
  /** Whether the user has expanded the MiniPlayer into the full HUD.
   *  Cover-click toggles to true; the expanded view's [X] button +
   *  a route-stop reset to false. */
  extendedOpen: boolean
  openExtended: () => void
  closeExtended: () => void
  /** Start playing a track from a YouTube URL. Returns false if the
   *  URL isn't a recognisable YouTube link.
   *
   *  Pass `{ start, end }` (in seconds) to play only a clip — the
   *  iframe starts at `start` and the global ticker loops the player
   *  back to `start` whenever it crosses `end`. Matches ScanVerse's
   *  profile-music clip behaviour. */
  playUrl: (
    url: string,
    opts?: {
      start?: number
      end?: number
      playerPlaqueId?: string | null
      playerEffectId?: string | null
    },
  ) => Promise<boolean>
  /** Start playing a track from a user-uploaded audio file
   *  (`profile_music_audio_path`). The renderer fetches the raw bytes
   *  via window.nexus.music.loadAudio, wraps them in a Blob, and
   *  drives an HTMLAudioElement. Same clip semantics as playUrl. */
  playAudio: (
    relativePath: string,
    meta: {
      title: string
      artist?: string | null
      albumArt?: string | null
      playerPlaqueId?: string | null
      playerEffectId?: string | null
    },
    opts?: { start?: number; end?: number },
  ) => Promise<boolean>
  /** Pre-save preview for a not-yet-uploaded audio file. The picker
   *  passes the File directly (avoiding an IPC round-trip + temporary
   *  disk write). Same playback semantics as playAudio. */
  playAudioBlob: (
    blob: Blob,
    meta: {
      title: string
      artist?: string | null
      albumArt?: string | null
      playerPlaqueId?: string | null
      playerEffectId?: string | null
    },
    opts?: { start?: number; end?: number },
  ) => Promise<boolean>
  /** Stop + tear down the iframe. Called by the profile page on
   *  unmount and by the MiniPlayer's close button. */
  stop: () => void
  togglePlay: () => void
  toggleMute: () => void
  setVolume: (v: number) => void
  seekTo: (seconds: number) => void
}

const MusicContext = createContext<MusicContextValue | null>(null)

// ── YT IFrame API typings + lazy loader ───────────────────────────
interface YTPlayer {
  playVideo: () => void
  pauseVideo: () => void
  stopVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  setVolume: (v: number) => void
  mute: () => void
  unMute: () => void
  getCurrentTime: () => number
  getDuration: () => number
  getVideoData: () => { title: string; author: string; video_id: string }
  destroy: () => void
}

interface YTPlayerEvent {
  target: YTPlayer
  data: number
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string
      playerVars?: Record<string, unknown>
      events?: {
        onReady?: (e: YTPlayerEvent) => void
        onStateChange?: (e: YTPlayerEvent) => void
        onError?: (e: { data: number }) => void
      }
    },
  ) => YTPlayer
  PlayerState: {
    ENDED: 0
    PLAYING: 1
    PAUSED: 2
    BUFFERING: 3
    CUED: 5
  }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

// The YT API exposes a single script. We load it lazily on first
// `playUrl()` to avoid paying ~10 KB on every launcher boot when the
// user never visits a profile.
let ytApiPromise: Promise<YTNamespace> | null = null

function loadYTApi(): Promise<YTNamespace> {
  if (ytApiPromise) return ytApiPromise
  ytApiPromise = new Promise<YTNamespace>((resolve) => {
    if (typeof window === 'undefined') return
    if (window.YT?.Player) {
      resolve(window.YT)
      return
    }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    tag.async = true
    window.onYouTubeIframeAPIReady = () => {
      if (window.YT) resolve(window.YT)
    }
    document.head.appendChild(tag)
  })
  return ytApiPromise
}

/**
 * Détecte si on est en runtime production (scheme custom `nexus://`)
 * ou en dev (http(s) — Vite). Le scheme détermine quel chemin de
 * lecture YouTube on utilise :
 *
 *   - http(s)  → YT IFrame API JS (state events + volume granulaire)
 *   - nexus:// → raw iframe (les postMessage de la YT IFrame API
 *                échouent dans les deux sens à cause de
 *                l'asymétrie origin embed/parent : si on passe
 *                origin=http(s)://youtube, le browser drop les
 *                messages embed→parent parce que target origin
 *                ne match pas le parent réel (nexus://). Si on
 *                passe origin=nexus://, l'embed refuse le
 *                handshake parce que c'est pas http(s).)
 */
function shouldUseRawIframe(): boolean {
  if (typeof location === 'undefined') return false
  return !/^https?:$/.test(location.protocol)
}

/**
 * Crée un adapter qui mime l'interface YT.Player en utilisant un raw
 * iframe `<iframe src="https://www.youtube.com/embed/...?autoplay=1">`.
 *
 * Trade-offs vs YT IFrame API :
 *   + Marche en prod (scheme nexus://) sans postMessage handshake
 *   + Pas besoin de loader le JS YT (économie réseau)
 *   - Pas de contrôle granulaire du volume cross-origin → setVolume
 *     est no-op (Mute/unmute via Windows mixer ou volume slider de
 *     l'app qui n'affecte que les autres sons)
 *   - Pas de state events réels (PLAYING/PAUSED) → on simule
 *     "playing" tant que l'iframe est attaché au DOM
 *   - Pas de getCurrentTime/getDuration réels → on compte
 *     manuellement depuis le mount (suffisant pour le clip loop +
 *     l'affichage de la progress bar)
 *   - Mute toggle rebuild l'iframe (= restart de la lecture). Pas
 *     idéal mais l'user mute rarement.
 *
 * onReady est résolu après 400 ms (laisse le temps à l'iframe de
 * commencer à charger). Le métadata est fetched via oEmbed
 * (`https://www.youtube.com/oembed`) qui ne nécessite pas d'API key.
 */
function createRawIframePlayer(
  container: HTMLElement,
  videoId: string,
  options: {
    clipStart: number
    clipEnd: number | null
    muted: boolean
    onReady: (player: YTPlayer) => void
    onMetadata: (data: { title: string; author: string }) => void
  },
): YTPlayer {
  let { clipStart, clipEnd, muted } = options
  let iframe: HTMLIFrameElement | null = null
  let mountTimestamp = Date.now() / 1000
  let elapsedAtMount = clipStart
  let userPaused = false

  function buildSrc(): string {
    const params = new URLSearchParams({
      autoplay: '1',
      controls: '0',
      modestbranding: '1',
      rel: '0',
      playsinline: '1',
      disablekb: '1',
      iv_load_policy: '3', // hide annotations
      // Loop : YT exige `playlist={videoId}` pour activer loop sur
      // un seul track. Sans ça, loop=1 est ignoré.
      loop: '1',
      playlist: videoId,
      mute: muted ? '1' : '0',
    })
    if (clipStart > 0) params.set('start', String(clipStart))
    if (clipEnd != null) params.set('end', String(clipEnd))
    return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`
  }

  function attach() {
    if (iframe) return
    iframe = document.createElement('iframe')
    iframe.allow = 'autoplay; encrypted-media'
    iframe.setAttribute('frameborder', '0')
    iframe.style.position = 'fixed'
    iframe.style.left = '-9999px'
    iframe.style.top = '-9999px'
    iframe.style.width = '1px'
    iframe.style.height = '1px'
    iframe.style.opacity = '0'
    iframe.style.pointerEvents = 'none'
    iframe.style.border = '0'
    iframe.src = buildSrc()
    container.appendChild(iframe)
    mountTimestamp = Date.now() / 1000
  }

  function detach() {
    if (!iframe) return
    try {
      if (iframe.parentElement) iframe.parentElement.removeChild(iframe)
    } catch {
      /* swallow */
    }
    iframe = null
  }

  // Mount immédiat avec autoplay → la musique commence à jouer.
  attach()

  // Fetch metadata via oEmbed (pas d'API key requise).
  // www.youtube.com/oembed accepte l'origine nexus:// (corsEnabled
  // sur notre scheme + corsAllowed côté YT).
  try {
    void fetch(
      `https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${encodeURIComponent(
        videoId,
      )}&format=json`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d === 'object') {
          const data = d as { title?: string; author_name?: string }
          options.onMetadata({
            title: data.title || 'YouTube',
            author: data.author_name || '',
          })
        }
      })
      .catch(() => {
        /* oEmbed CDN down ou bloqué — on garde le placeholder */
      })
  } catch {
    /* swallow */
  }

  // Implémente l'interface YT.Player. Les méthodes sont best-effort
  // — on rebuild l'iframe pour les changements qui nécessitent un
  // nouveau src (clipStart/clipEnd/mute), et on no-op pour ce qu'on
  // peut pas faire cross-origin (setVolume).
  const player: YTPlayer = {
    playVideo() {
      userPaused = false
      attach()
    },
    pauseVideo() {
      userPaused = true
      // Sauve l'elapsed local avant de détacher pour que le resume
      // continue à peu près au bon endroit (best-effort).
      elapsedAtMount =
        elapsedAtMount + (Date.now() / 1000 - mountTimestamp)
      detach()
    },
    stopVideo() {
      userPaused = true
      elapsedAtMount = clipStart
      detach()
    },
    seekTo(seconds: number) {
      // Pour seek, on rebuild l'iframe avec start=seconds. Pas idéal
      // (interruption de 100-300 ms) mais c'est la seule option
      // cross-origin.
      const target = Math.max(0, Math.floor(seconds))
      clipStart = target
      elapsedAtMount = target
      detach()
      if (!userPaused) attach()
    },
    setVolume() {
      // Cross-origin iframe : on peut pas régler le volume sans
      // postMessage handshake. No-op silencieux. L'user peut
      // ajuster via le Windows volume mixer ou couper avec mute.
    },
    mute() {
      if (muted) return
      muted = true
      // Save elapsed before rebuilding
      const elapsed = elapsedAtMount + (Date.now() / 1000 - mountTimestamp)
      clipStart = Math.floor(elapsed)
      elapsedAtMount = clipStart
      detach()
      if (!userPaused) attach()
    },
    unMute() {
      if (!muted) return
      muted = false
      const elapsed = elapsedAtMount + (Date.now() / 1000 - mountTimestamp)
      clipStart = Math.floor(elapsed)
      elapsedAtMount = clipStart
      detach()
      if (!userPaused) attach()
    },
    getCurrentTime() {
      if (userPaused) return elapsedAtMount
      return elapsedAtMount + (Date.now() / 1000 - mountTimestamp)
    },
    getDuration() {
      // Pas accessible cross-origin. On retourne 0 → la progress bar
      // tombera en mode "infini" mais ne crashera pas. Le clip end
      // (si défini) sert de duration fictive pour la barre.
      if (clipEnd != null) return clipEnd
      return 0
    },
    getVideoData() {
      return { title: 'YouTube', author: '', video_id: videoId }
    },
    destroy() {
      detach()
    },
  }

  // Fire onReady après un court délai → laisse le temps à l'iframe
  // de commencer à charger, et au state du parent de finir son set.
  // Sans ce délai, le caller pourrait essayer d'appeler playVideo()
  // pendant qu'on attach déjà l'iframe (no-op mais bruyant).
  window.setTimeout(() => options.onReady(player), 400)

  return player
}

const VOL_KEY = 'nexus_music_vol'
const MUTED_KEY = 'nexus_music_muted'

export function MusicProvider({ children }: { children: ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<PlayingTrack | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(() => {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(MUTED_KEY) === 'true'
  })
  const [volume, setVolumeState] = useState(() => {
    if (typeof localStorage === 'undefined') return 0.7
    const v = parseFloat(localStorage.getItem(VOL_KEY) || '0.7')
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7
  })
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // Expanded-view toggle — driven by MiniPlayer cover-click + the
  // [X] on the expanded surface. Reset to false in stop() so closing
  // the player also collapses the HUD.
  const [extendedOpen, setExtendedOpen] = useState(false)
  // Clip window mirror to state (clipRef est la source de vérité pour
  // le ticker interne, ces deux states sont exposés aux consumers
  // pour affichage du temps relatif au clip).
  const [clipStart, setClipStartState] = useState(0)
  const [clipEnd, setClipEndState] = useState<number | null>(null)

  // Hidden iframe container — appended to <body> once, reused for
  // every track swap so the YT API doesn't have to bootstrap twice.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  // Local-audio fallback path : when the user uploaded a file instead
  // of pasting a YT URL, we drive an HTMLAudioElement instead of the
  // YT iframe. Only ONE of (playerRef, audioRef) is live at any time —
  // stop() nukes both before a new track loads.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // ObjectURL we created from the loaded audio blob — must be revoked
  // on stop() to release the bytes (a 5 Mo audio file lingering as an
  // ObjectURL keeps that memory permanently allocated otherwise).
  const audioObjectUrlRef = useRef<string | null>(null)
  const tickerRef = useRef<number | null>(null)
  // Clip window for the currently-loaded track. When `end` is set, the
  // ticker loops the player back to `start` once currentTime crosses
  // it — ScanVerse-style profile-music clip behaviour. Works for both
  // YT and audio playback backends.
  const clipRef = useRef<{ start: number; end: number } | null>(null)
  // Sequence token — incrémenté à chaque appel de stop() ET au début
  // de chaque play*. Les play* asynchrones capturent le token APRÈS
  // leur appel à stop(), puis vérifient APRÈS leur await que le
  // token est toujours courant. Si non (parce qu'un autre play* ou
  // un stop() externe a fire entre temps), on abandonne — sans ça,
  // React.StrictMode en dev double-monte les effets, deux playAudio
  // partent en parallèle, leurs awaits résolvent dans le désordre,
  // et on se retrouve avec deux <audio> attachés au body qui jouent
  // simultanément (le second overwrite la ref mais le premier reste
  // orphelin dans le DOM).
  const sequenceRef = useRef(0)

  // Pause/resume on tab visibility — matches ScanVerse's
  // wasPlayingBeforeHidden trick so the music doesn't keep
  // playing on a buried tab.
  const wasPlayingBeforeHiddenRef = useRef(false)
  useEffect(() => {
    function onVisibility() {
      const p = playerRef.current
      const a = audioRef.current
      if (!p && !a) return
      if (document.hidden) {
        wasPlayingBeforeHiddenRef.current = isPlaying
        if (isPlaying) {
          if (p) p.pauseVideo()
          if (a) a.pause()
        }
      } else if (wasPlayingBeforeHiddenRef.current) {
        wasPlayingBeforeHiddenRef.current = false
        if (p) p.playVideo()
        if (a) void a.play()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [isPlaying])

  // 250 ms progress ticker — drives the MiniPlayer's elapsed-time
  // display + progress bar. Cleaned up on stop / unmount.
  useEffect(() => {
    function tick() {
      // Branch on which backend is currently live. Only one of the two
      // is non-null at any time (stop() enforces this).
      const yt = playerRef.current
      const audio = audioRef.current
      try {
        if (yt) {
          const t = yt.getCurrentTime()
          setCurrentTime(t)
          const d = yt.getDuration()
          if (d > 0) setDuration(d)
          const clip = clipRef.current
          // Clip loop — if the user picked a clip window and we've
          // crossed the end (with a 0.25 s buffer to absorb ticker
          // jitter), seek back to the clip start. Without this the
          // YT-end-param sometimes lets the track play past the end
          // before triggering ENDED, especially on first play.
          if (clip && t >= clip.end - 0.25) {
            yt.seekTo(clip.start, true)
          }
        } else if (audio) {
          const t = audio.currentTime
          setCurrentTime(t)
          // HTMLAudioElement.duration becomes available right after
          // 'loadedmetadata'. Setting it once is enough but cheap to
          // re-set on every tick (no rerender if value unchanged).
          if (!isNaN(audio.duration) && audio.duration > 0) {
            setDuration(audio.duration)
          }
          const clip = clipRef.current
          if (clip && t >= clip.end - 0.25) {
            audio.currentTime = clip.start
          }
        }
      } catch {
        /* not ready yet — ignore */
      }
    }
    if (isPlaying) {
      tickerRef.current = window.setInterval(tick, 250)
    } else if (tickerRef.current) {
      clearInterval(tickerRef.current)
      tickerRef.current = null
    }
    return () => {
      if (tickerRef.current) {
        clearInterval(tickerRef.current)
        tickerRef.current = null
      }
    }
    // currentTrack.kind is part of the dep so the ticker re-binds when
    // the user switches between YT and audio backends — otherwise the
    // closed-over `yt`/`audio` snapshot from the previous track would
    // keep referencing the wrong (now-null) backend.
  }, [isPlaying, currentTrack?.kind])

  const stop = useCallback(() => {
    // Invalide tous les play* en cours — si un await loadAudio /
    // loadYTApi termine après ce stop(), le check seq fera bail-out.
    sequenceRef.current += 1
    // YT backend teardown.
    const p = playerRef.current
    if (p) {
      try {
        p.stopVideo()
        p.destroy()
      } catch {
        /* swallow — iframe may have been removed */
      }
    }
    playerRef.current = null
    if (containerRef.current && containerRef.current.parentElement) {
      containerRef.current.parentElement.removeChild(containerRef.current)
    }
    containerRef.current = null
    // Audio backend teardown — pause + détache du DOM + drop ref +
    // revoke object URL pour que le 5 Mo blob soit GC'd. Skipper le
    // revoke fuit jusqu'au reload de la page.
    const a = audioRef.current
    if (a) {
      try {
        a.pause()
        a.src = ''
        if (a.parentElement) a.parentElement.removeChild(a)
      } catch {
        /* swallow */
      }
    }
    audioRef.current = null
    if (audioObjectUrlRef.current) {
      try {
        URL.revokeObjectURL(audioObjectUrlRef.current)
      } catch {
        /* swallow */
      }
      audioObjectUrlRef.current = null
    }
    clipRef.current = null
    setClipStartState(0)
    setClipEndState(null)
    setCurrentTrack(null)
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setExtendedOpen(false)
  }, [])

  const openExtended = useCallback(() => setExtendedOpen(true), [])
  const closeExtended = useCallback(() => setExtendedOpen(false), [])

  const playUrl = useCallback(
    async (
      url: string,
      opts?: {
        start?: number
        end?: number
        playerPlaqueId?: string | null
        playerEffectId?: string | null
      },
    ): Promise<boolean> => {
      const videoId = extractYouTubeId(url)
      if (!videoId) return false
      // Sanitize the clip window — we only set clipRef if both bounds
      // are sane and end > start. Otherwise the clip-loop ticker would
      // immediately rewind the player on the first tick.
      const clipStart = Math.max(0, Math.floor(opts?.start ?? 0))
      const clipEnd =
        typeof opts?.end === 'number' && opts.end > clipStart
          ? Math.floor(opts.end)
          : null
      // If the same track is already playing, no-op — the profile
      // page calls playUrl on every render and we don't want to
      // restart the song just because the parent re-rendered.
      if (currentTrack?.videoId === videoId && playerRef.current) {
        // Refresh the clip window in case the user edited the start/end
        // sliders without changing tracks.
        clipRef.current = clipEnd ? { start: clipStart, end: clipEnd } : null
        setClipStartState(clipStart)
        setClipEndState(clipEnd)
        return true
      }
      // Tear down any previous player before creating a new one —
      // the YT API doesn't support swapping videoIds in place
      // reliably across browsers.
      stop()
      // Capture le seq APRÈS stop() (qui a incrémenté). Si un autre
      // play* ou stop() externe fire pendant l'await ci-dessous, on
      // bail out — sans ça, deux iframes YT seraient mountées dans le
      // body en parallèle.
      const mySeq = sequenceRef.current

      // Détermine quel backend YT utiliser AVANT de loader la YT JS
      // API (économie réseau en prod : on charge pas iframe_api.js).
      const useRawIframe = shouldUseRawIframe()

      // En dev (http://localhost) on charge la YT IFrame API JS pour
      // avoir tous les events + le contrôle granulaire du volume.
      // En prod (nexus://) on skip — l'asymétrie origin embed/parent
      // empêche le postMessage handshake.
      const YT = useRawIframe ? null : await loadYTApi()
      if (mySeq !== sequenceRef.current) return false

      // Mount a fresh container off-viewport. 1×1 px works on every
      // browser and bypasses display:none restrictions some
      // browsers apply to audio in hidden frames.
      const container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.top = '-9999px'
      container.style.width = '1px'
      container.style.height = '1px'
      container.style.opacity = '0'
      container.style.pointerEvents = 'none'
      document.body.appendChild(container)
      containerRef.current = container

      // Pre-set the track with placeholder metadata. The YT API's
      // `getVideoData()` fills in the real title + author once the
      // player is ready, but we want the MiniPlayer card to mount
      // immediately rather than blink in 200 ms later.
      const placeholder: PlayingTrack = {
        kind: 'youtube',
        videoId,
        audioPath: null,
        title: 'Chargement…',
        artist: null,
        // YouTube exposes a deterministic thumbnail URL for every
        // video id. `maxresdefault` falls back to `hqdefault` if
        // the uploader didn't provide a 720p still, but most do.
        // maxresdefault = 1280×720, vrai 16:9, AUCUNE bande noire +
        // 4× plus de résolution que hqdefault (480×360 avec letterbox).
        // Le container 1:1 crop via object-cover → on garde la qualité
        // sans bandes. Fallback hqdefault via onError dans les
        // composants (maxresdefault n'existe pas pour toutes les
        // vidéos, surtout les uploads non-HD pré-2017).
        albumArt: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        playerPlaqueId: opts?.playerPlaqueId ?? null,
        playerEffectId: opts?.playerEffectId ?? null,
      }
      setCurrentTrack(placeholder)

      clipRef.current = clipEnd ? { start: clipStart, end: clipEnd } : null
      setClipStartState(clipStart)
      setClipEndState(clipEnd)

      // ── Path A : Raw iframe (prod / nexus://) ──────────────────────
      if (useRawIframe || !YT) {
        await new Promise<void>((resolve) => {
          playerRef.current = createRawIframePlayer(container, videoId, {
            clipStart,
            clipEnd,
            muted: isMuted,
            onReady: () => {
              // L'iframe est attaché, on assume "playing" — pas de
              // state event réel cross-origin, donc on signale au
              // consumer (MiniPlayer) que la musique tourne pour qu'il
              // affiche le bouton Pause + commence le ticker.
              setIsPlaying(true)
              resolve()
            },
            onMetadata: (data) => {
              if (data.title) {
                setCurrentTrack((prev) =>
                  prev
                    ? {
                        ...prev,
                        title: data.title,
                        artist: data.author || prev.artist,
                      }
                    : prev,
                )
              }
            },
          })
        })
        return true
      }

      // ── Path B : YT IFrame API (dev / http(s)) ─────────────────────
      await new Promise<void>((resolve) => {
        playerRef.current = new YT.Player(container, {
          videoId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            // Seed the iframe with the clip bounds so playback starts
            // at the user's chosen offset. The ticker handles the loop
            // (YT's `end` param is unreliable on the first play).
            ...(clipStart > 0 ? { start: clipStart } : {}),
            ...(clipEnd != null ? { end: clipEnd } : {}),
            // Origin handling — la YT IFrame API valide le champ
            // `origin` côté embed page : si ce n'est pas http(s)://
            // (ex: `nexus://.`), l'embed refuse le postMessage
            // handshake et le player ne joue jamais.
            //
            // SUBTLE : omettre l'origin ne suffit PAS parce que la YT
            // IFrame API JS injecte automatiquement
            // `origin = origin || window.location.origin` avant
            // d'appeler l'embed. Donc on doit le passer EXPLICITEMENT
            // à une valeur acceptée. Astuce connue : passer l'origin
            // de l'embed lui-même (`https://www.youtube.com`) →
            // l'embed voit "même origine que moi" et skip la validation.
            // Aucun impact sécurité : la communication postMessage
            // continue de marcher (l'embed envoie depuis sa vraie
            // origine youtube.com, notre handler vérifie ça).
            //
            // En dev (Vite http://localhost:5173) on garde l'origin
            // réel pour la sécurité standard.
            origin:
              typeof location !== 'undefined' &&
              /^https?:$/.test(location.protocol)
                ? location.origin
                : 'https://www.youtube.com',
          },
          events: {
            onReady: (e) => {
              try {
                e.target.setVolume(Math.round((isMuted ? 0 : volume) * 100))
                if (isMuted) e.target.mute()
                e.target.playVideo()
                // Refresh placeholder with real metadata.
                const data = e.target.getVideoData()
                if (data?.title) {
                  setCurrentTrack({
                    ...placeholder,
                    title: data.title,
                    artist: data.author || null,
                  })
                }
              } catch {
                /* swallow */
              }
              resolve()
            },
            onStateChange: (e) => {
              switch (e.data) {
                case YT.PlayerState.PLAYING:
                  setIsPlaying(true)
                  // Hydrate title + artist on the first PLAYING tick
                  // too — sometimes getVideoData is empty during
                  // onReady but populated a moment later.
                  try {
                    const data = e.target.getVideoData()
                    if (data?.title) {
                      setCurrentTrack((prev) =>
                        prev
                          ? {
                              ...prev,
                              title: data.title,
                              artist: data.author || prev.artist,
                            }
                          : prev,
                      )
                    }
                  } catch {
                    /* swallow */
                  }
                  break
                case YT.PlayerState.PAUSED:
                  setIsPlaying(false)
                  break
                case YT.PlayerState.ENDED:
                  // Loop the same track — matches ScanVerse's
                  // single-track behaviour. The user's profile music
                  // is "ambient", not a queue, so looping is exactly
                  // what they want. Honours the clip start if set
                  // (otherwise restarts from the beginning).
                  try {
                    e.target.seekTo(clipRef.current?.start ?? 0, true)
                    e.target.playVideo()
                  } catch {
                    setIsPlaying(false)
                  }
                  break
              }
            },
            onError: () => {
              // YT error codes (2, 5, 100, 101, 150) — surface as
              // "playback failed" by zeroing out the player. The
              // MiniPlayer hides itself when `currentTrack === null`.
              stop()
            },
          },
        })
      })
      return true
    },
    [currentTrack?.videoId, isMuted, stop, volume],
  )

  // ── Local audio playback (user-uploaded file) ───────────────
  // Same surface as playUrl but for kind='audio' tracks. Two entry
  // points :
  //   - playAudio(relativePath)  → IPC-loaded persisted file
  //   - playAudioBlob(blob)      → in-memory pre-save preview
  // Both end up calling the shared `mountAudioElement` helper, which
  // sets up the <audio>, the clip ref, the state listeners, and
  // hands back. The ticker (above) handles tick → clip loop.
  const mountAudioElement = useCallback(
    (
      objectUrl: string,
      kind: 'audio',
      track: PlayingTrack,
      clipStart: number,
      clipEnd: number | null,
    ): void => {
      audioObjectUrlRef.current = objectUrl

      const audio = document.createElement('audio')
      audio.src = objectUrl
      audio.preload = 'auto'
      audio.volume = isMuted ? 0 : volume
      audio.muted = isMuted
      // Loop is handled by the ticker (so the clip window is honoured).
      // Native loop would ignore clipRef and play the whole file.
      audio.loop = false
      // CRITIQUE — attache l'élément au body. Certaines combinaisons
      // Electron/Chromium refusent de driver un <audio> détaché du DOM
      // (pas d'événements 'playing'/'pause' fiables, .play() peut
      // silencieusement no-op). On le cache via style absolute hors
      // viewport — équivalent du pattern hidden-iframe pour YT.
      audio.style.position = 'fixed'
      audio.style.left = '-9999px'
      audio.style.top = '-9999px'
      audio.style.pointerEvents = 'none'
      document.body.appendChild(audio)
      audioRef.current = audio

      clipRef.current = clipEnd ? { start: clipStart, end: clipEnd } : null
      setClipStartState(clipStart)
      setClipEndState(clipEnd)

      audio.addEventListener('playing', () => setIsPlaying(true))
      audio.addEventListener('pause', () => setIsPlaying(false))
      audio.addEventListener('ended', () => {
        try {
          audio.currentTime = clipRef.current?.start ?? 0
          audio.play().catch((err) => {
            console.warn('[MusicContext] audio loop replay rejected:', err)
            setIsPlaying(false)
          })
        } catch (err) {
          console.warn('[MusicContext] audio loop replay threw:', err)
          setIsPlaying(false)
        }
      })
      audio.addEventListener('loadedmetadata', () => {
        // Push the audio's real duration up to the consumer state so
        // the MiniPlayer's progress bar + the picker's slider can lock
        // onto the actual file length instead of the 5 min default.
        if (!isNaN(audio.duration) && audio.duration > 0) {
          setDuration(audio.duration)
        }
        if (clipStart > 0) audio.currentTime = clipStart
        audio.play().catch((err) => {
          // Chrome's autoplay policy may block this in some contexts ;
          // pas grave, l'user peut cliquer Play. On log juste pour le
          // debug.
          console.warn('[MusicContext] audio initial play rejected:', err)
        })
      })
      audio.addEventListener('error', () => stop())

      setCurrentTrack(track)
      // Mark the suppressing-the-unused-warning of `kind` — used only
      // for the explicit discriminator on `track`.
      void kind
    },
    [isMuted, stop, volume],
  )

  const playAudio = useCallback(
    async (
      relativePath: string,
      meta: {
        title: string
        artist?: string | null
        albumArt?: string | null
        playerPlaqueId?: string | null
        playerEffectId?: string | null
      },
      opts?: { start?: number; end?: number },
    ): Promise<boolean> => {
      if (!relativePath) return false
      const clipStart = Math.max(0, Math.floor(opts?.start ?? 0))
      const clipEnd =
        typeof opts?.end === 'number' && opts.end > clipStart
          ? Math.floor(opts.end)
          : null
      if (currentTrack?.audioPath === relativePath && audioRef.current) {
        clipRef.current = clipEnd ? { start: clipStart, end: clipEnd } : null
        setClipStartState(clipStart)
        setClipEndState(clipEnd)
        return true
      }
      stop()
      // Capture le seq APRÈS stop() (qui a incrémenté). Si un autre
      // play* ou stop() fire pendant l'await, sequenceRef changera et
      // on bail out avant de créer un audio orphelin.
      const mySeq = sequenceRef.current

      const res = await window.nexus.music.loadAudio(relativePath)
      if (!res.ok) return false
      if (mySeq !== sequenceRef.current) return false

      const blob = new Blob([new Uint8Array(res.bytes)], { type: 'audio/*' })
      const objectUrl = URL.createObjectURL(blob)
      mountAudioElement(
        objectUrl,
        'audio',
        {
          kind: 'audio',
          videoId: '',
          audioPath: relativePath,
          title: meta.title,
          artist: meta.artist ?? null,
          albumArt: meta.albumArt ?? '',
          playerPlaqueId: meta.playerPlaqueId ?? null,
          playerEffectId: meta.playerEffectId ?? null,
        },
        clipStart,
        clipEnd,
      )
      return true
    },
    [currentTrack?.audioPath, mountAudioElement, stop],
  )

  const playAudioBlob = useCallback(
    async (
      blob: Blob,
      meta: {
        title: string
        artist?: string | null
        albumArt?: string | null
        playerPlaqueId?: string | null
        playerEffectId?: string | null
      },
      opts?: { start?: number; end?: number },
    ): Promise<boolean> => {
      if (!blob) return false
      const clipStart = Math.max(0, Math.floor(opts?.start ?? 0))
      const clipEnd =
        typeof opts?.end === 'number' && opts.end > clipStart
          ? Math.floor(opts.end)
          : null
      // Pre-save preview always restarts the player — there's no
      // stable id to dedupe against (the file might have the same
      // name but different bytes, etc.).
      stop()
      const objectUrl = URL.createObjectURL(blob)
      mountAudioElement(
        objectUrl,
        'audio',
        {
          kind: 'audio',
          videoId: '',
          // No persisted path yet — we use a sentinel so the dedupe
          // check above never matches against this preview track on
          // subsequent calls.
          audioPath: '__preview__',
          title: meta.title,
          artist: meta.artist ?? null,
          albumArt: meta.albumArt ?? '',
          playerPlaqueId: meta.playerPlaqueId ?? null,
          playerEffectId: meta.playerEffectId ?? null,
        },
        clipStart,
        clipEnd,
      )
      return true
    },
    [mountAudioElement, stop],
  )

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    const a = audioRef.current
    if (p) {
      if (isPlaying) p.pauseVideo()
      else p.playVideo()
    } else if (a) {
      if (isPlaying) {
        a.pause()
      } else {
        // Catch — sur certains chemins (autoplay bloqué pré-clic),
        // l'audio peut être dans un état où play() rejette ; on log
        // pour aider au debug et on laisse isPlaying false (le bouton
        // restera visible avec l'icône Play, prochain clic ré-essaie).
        a.play().catch((err) => {
          console.warn('[MusicContext] togglePlay audio.play rejected:', err)
        })
      }
    }
  }, [isPlaying])

  const toggleMute = useCallback(() => {
    const p = playerRef.current
    const a = audioRef.current
    setIsMuted((prev) => {
      const next = !prev
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MUTED_KEY, String(next))
      }
      try {
        if (p) {
          if (next) p.mute()
          else p.unMute()
        }
        if (a) {
          a.muted = next
        }
      } catch {
        /* swallow */
      }
      return next
    })
  }, [])

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    setVolumeState(clamped)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VOL_KEY, String(clamped))
    }
    const p = playerRef.current
    const a = audioRef.current
    try {
      if (p) p.setVolume(Math.round(clamped * 100))
      if (a) a.volume = clamped
    } catch {
      /* swallow */
    }
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const p = playerRef.current
    const a = audioRef.current
    try {
      if (p) p.seekTo(seconds, true)
      else if (a) a.currentTime = seconds
      else return
      setCurrentTime(seconds)
    } catch {
      /* swallow */
    }
  }, [])

  // Progress relatif au clip — si un clip est défini, on map
  // [clipStart, clipEnd] → [0, 1]. Sans clip, on map [0, duration].
  // Le MiniPlayer / ExtendedPlayer affichent ce ratio sur la barre
  // de progression, donc l'user voit le clip avancer de 0% à 100%
  // (pas le track entier).
  const progress = (() => {
    if (clipEnd != null && clipEnd > clipStart) {
      const clipDur = clipEnd - clipStart
      return Math.min(1, Math.max(0, (currentTime - clipStart) / clipDur))
    }
    return duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0
  })()

  // Tear down the iframe when the provider unmounts — covers HMR
  // reloads in dev, makes sure we don't leave a ghost iframe in the
  // DOM keeping audio alive after the app refreshes.
  useEffect(() => {
    return () => stop()
  }, [stop])

  return (
    <MusicContext.Provider
      value={{
        currentTrack,
        isPlaying,
        isMuted,
        volume,
        currentTime,
        duration,
        progress,
        clipStart,
        clipEnd,
        playUrl,
        playAudio,
        playAudioBlob,
        stop,
        togglePlay,
        toggleMute,
        setVolume,
        seekTo,
        extendedOpen,
        openExtended,
        closeExtended,
      }}
    >
      {children}
    </MusicContext.Provider>
  )
}

export function useMusic(): MusicContextValue {
  const ctx = useContext(MusicContext)
  if (!ctx) throw new Error('useMusic must be used inside <MusicProvider>')
  return ctx
}
