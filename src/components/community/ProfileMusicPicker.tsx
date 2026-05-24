/**
 * ProfileMusicPicker — port 1×1 du card "Musique de profil"
 * de ScanVerse → Settings → Musique tab (cf. SettingsPage.jsx
 * lignes ~1797-2450).
 *
 * Surface complète :
 *   1. Source — soit URL YouTube + Analyser, soit upload audio (5 Mo max)
 *   2. Track preview card (cover + titre + artiste) après analyse / upload
 *   3. DualRangeSlider 5 min + "Aperçu sur le lecteur"
 *   4. Plaque animée du lecteur — grid 3/5 cols (Aucune + 8 quick picks
 *      + "+" qui ouvre MusicCosmeticsModal kind='plaque')
 *   5. Animation du lecteur étendu — chip + bouton "Choisir" qui ouvre
 *      MusicCosmeticsModal kind='effect'
 *   6. Save / Modifier / Supprimer
 *
 * Persistance — un seul appel profile.updateCosmetics, qui patch :
 *   profileMusicUrl       (null si l'user a uploadé un fichier)
 *   profileMusicAudioPath (null si l'user a collé une URL YouTube)
 *   profileMusicStart / End
 *   profileMusicPlaqueId
 *   profileMusicEffectId
 *
 * Playback — délègue à MusicContext :
 *   - playUrl(url, { start, end })   pour YouTube
 *   - playAudio(path, meta, { start, end }) pour audio local
 */
import { useEffect, useRef, useState } from 'react'
import { Music, Play, Square, Pencil, Trash2, Upload, Plus, X } from '@/lib/icons'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DualRangeSlider } from '@/components/ui/DualRangeSlider'
import { MusicCosmeticsModal } from '@/components/community/MusicCosmeticsModal'
import { useAuthStore } from '@/stores/auth.store'
import { useMusic } from '@/context/MusicContext'
import { useLocalPreview } from '@/hooks/useLocalPreview'
import {
  NAMEPLATES,
  PROFILE_EFFECTS_BY_ID,
  type Nameplate,
} from '@/config/profileCosmetics'
import { cn } from '@/utils/cn'

/** Durée par défaut du slider quand on ne connait pas la vraie durée
 *  de la track (oEmbed ne la fournit pas). 300 s = clip max ScanVerse. */
const DEFAULT_DURATION = 300
/** Fenêtre maximum de l'extrait (5 minutes). */
const CLIP_MAX_WINDOW = 300
/** Hard cap upload — doublon avec music.service mais ça évite la
 *  round-trip IPC quand le user choisit un fichier de 50 Mo. */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024
/** Nombre de plaques affichées dans la grille inline (les autres
 *  sont accessibles via le bouton "+" qui ouvre MusicCosmeticsModal). */
const PLAQUE_QUICK_PICKS = 8

/**
 * Promote stored YouTube thumbnail URLs from `hqdefault.jpg` (480×360
 * 4:3 letterboxé avec VRAIES bandes noires baked-in dans les pixels) à
 * `maxresdefault.jpg` (1280×720 vrai 16:9 sans bandes). Le service
 * backend a été mis à jour pour stocker maxresdefault d'office, mais
 * les rows déjà persistés en DB gardent leur ancienne URL avec bandes
 * — ce helper rattrape ça à l'affichage. Le `onError` côté composant
 * gère ensuite le fallback vers `mqdefault.jpg` quand maxresdefault
 * n'existe pas (uploads non-HD pré-2017).
 */
function upgradeYouTubeThumbnail(url: string | null | undefined): string {
  if (!url) return ''
  if (url.includes('/hqdefault.jpg')) {
    return url.replace('/hqdefault.jpg', '/maxresdefault.jpg')
  }
  return url
}

interface TrackMeta {
  videoId: string
  title: string
  author: string | null
  thumbnail: string
}

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ProfileMusicPicker() {
  const user = useAuthStore((s) => s.user)
  const { playUrl, playAudio } = useMusic()
  // Preview locale — pas dans le MusicContext global, donc n'active
  // pas le MiniPlayer. Pattern ScanVerse : on instancie un <audio>
  // (ou un iframe YT) caché ad hoc qui meurt à la fin de l'extrait.
  const preview = useLocalPreview()

  // Persisted state — refreshed on mount + after every save.
  // Source dichotomy : exactement un de (savedUrl, savedAudioPath) est
  // non-null à la fois (le save flow clear l'autre côté avant write).
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [savedAudioPath, setSavedAudioPath] = useState<string | null>(null)
  const [savedStart, setSavedStart] = useState<number>(0)
  const [savedEnd, setSavedEnd] = useState<number>(DEFAULT_DURATION)
  const [savedMeta, setSavedMeta] = useState<TrackMeta | null>(null)
  const [savedPlaqueId, setSavedPlaqueId] = useState<string | null>(null)
  const [savedEffectId, setSavedEffectId] = useState<string | null>(null)

  // Edit-mode state.
  const [editMode, setEditMode] = useState(false)
  const [url, setUrl] = useState('')
  const [analysing, setAnalysing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [draftMeta, setDraftMeta] = useState<TrackMeta | null>(null)
  const [clipStart, setClipStart] = useState(0)
  const [clipEnd, setClipEnd] = useState(DEFAULT_DURATION)
  const [saving, setSaving] = useState(false)

  // Upload state — when the user picks a local audio file. Mutually
  // exclusive with `url` : choosing one path clears the other so
  // the save flow always knows which source to persist.
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [audioUploadError, setAudioUploadError] = useState<string | null>(null)

  // Real track duration in seconds. For audio files we probe it via a
  // throwaway <audio> on file pick ; for YouTube we sync from
  // MusicContext.duration once the user previews and the iframe
  // reports it. Falls back to DEFAULT_DURATION (300 s) until either
  // source resolves — same as ScanVerse's first-load behaviour.
  const [trackDuration, setTrackDuration] = useState<number>(DEFAULT_DURATION)

  // Cosmetics scoped to the music HUD (independent of profile-level
  // plaque/effect).
  const [draftPlaqueId, setDraftPlaqueId] = useState<string | null>(null)
  const [draftEffectId, setDraftEffectId] = useState<string | null>(null)

  // Modal toggles for the full-catalogue browsers.
  const [plaqueModalOpen, setPlaqueModalOpen] = useState(false)
  const [effectModalOpen, setEffectModalOpen] = useState(false)

  // Hidden file input — clicked programmatically by the upload button.
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Sync trackDuration depuis la preview locale — pour YouTube le
  // getDuration() n'est dispo qu'une fois l'iframe loadée, donc on
  // attend que le user clique "Prévisualiser la sélection" et on
  // récupère la vraie longueur depuis `useLocalPreview.previewDuration`.
  // Pour les fichiers audio, la durée est déjà setée via le probe
  // dans onFilePicked, mais previewDuration sert de fallback si le
  // probe a raté.
  useEffect(() => {
    if (preview.previewDuration <= 0) return
    const dur = Math.min(preview.previewDuration, 60 * 60)
    setTrackDuration((prev) => (Math.abs(prev - dur) > 0.5 ? dur : prev))
    setClipEnd((prev) => Math.min(prev, dur))
  }, [preview.previewDuration])

  // Fetch the user's currently-saved music on mount. We also fetch
  // its oEmbed metadata so the display mode can show cover/title.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    void (async () => {
      const cos = await window.nexus.profile.getCosmetics(user.id)
      if (cancelled || !cos?.ok || !cos.cosmetics) return
      const c = cos.cosmetics
      setSavedUrl(c.profileMusicUrl ?? null)
      setSavedAudioPath(c.profileMusicAudioPath ?? null)
      setSavedStart(c.profileMusicStart ?? 0)
      setSavedEnd(c.profileMusicEnd ?? DEFAULT_DURATION)
      setSavedPlaqueId(c.profileMusicPlaqueId ?? null)
      setSavedEffectId(c.profileMusicEffectId ?? null)
      // Only YouTube tracks have remote-fetchable metadata. For an
      // uploaded audio file we show "Fichier audio" + the persisted
      // start/end and skip the oEmbed roundtrip.
      if (c.profileMusicUrl) {
        const meta = await window.nexus.music.analyzeYouTube(c.profileMusicUrl)
        if (!cancelled && meta.ok) setSavedMeta(meta.meta)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.id])

  // ── YouTube duration probe ──────────────────────────────────
  // En edit mode, dès qu'on a un draftMeta (YouTube), mount un YT
  // iframe en autoplay=0 juste pour lire getDuration() puis le
  // détruire. Sans ça, le slider reste bloqué à DEFAULT_DURATION
  // (5 min) jusqu'à ce que l'user clique "Prévisualiser" — frustrant
  // quand on édite un track de 3:17 avec un slider qui dit 5:00.
  useEffect(() => {
    if (!editMode || !draftMeta?.videoId) return
    if (audioFile) return // audio file = duration vient du probe Audio dans onFilePicked
    let cancelled = false
    let player: { destroy: () => void } | null = null
    let container: HTMLDivElement | null = null
    void (async () => {
      const w = window as unknown as {
        YT?: {
          Player: new (
            el: HTMLElement,
            opts: {
              videoId: string
              playerVars?: Record<string, unknown>
              events?: {
                onReady?: (e: {
                  target: { getDuration: () => number; destroy: () => void }
                }) => void
                onError?: () => void
              }
            },
          ) => { destroy: () => void }
        }
        onYouTubeIframeAPIReady?: () => void
      }
      // Charge l'API YT si pas déjà loadée (réutilise la même
      // promesse que le MusicContext et useLocalPreview via le tag
      // script déjà attaché au document).
      if (!w.YT?.Player) {
        await new Promise<void>((resolve) => {
          if (w.YT?.Player) {
            resolve()
            return
          }
          const existing = document.querySelector(
            'script[src="https://www.youtube.com/iframe_api"]',
          )
          if (!existing) {
            const tag = document.createElement('script')
            tag.src = 'https://www.youtube.com/iframe_api'
            tag.async = true
            document.head.appendChild(tag)
          }
          const prev = w.onYouTubeIframeAPIReady
          w.onYouTubeIframeAPIReady = () => {
            if (prev) prev()
            resolve()
          }
          // Fallback : si l'API était en cours de chargement quand on
          // est entré ici, poll quelques fois.
          let tries = 0
          const poll = setInterval(() => {
            tries += 1
            if (w.YT?.Player) {
              clearInterval(poll)
              resolve()
            } else if (tries > 50) {
              clearInterval(poll)
              resolve() // bail out — pas grave, l'user pourra preview
            }
          }, 100)
        })
      }
      if (cancelled || !w.YT?.Player) return

      container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.top = '-9999px'
      container.style.width = '1px'
      container.style.height = '1px'
      container.style.opacity = '0'
      container.style.pointerEvents = 'none'
      document.body.appendChild(container)

      player = new w.YT.Player(container, {
        videoId: draftMeta.videoId,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1 },
        events: {
          onReady: (e) => {
            if (cancelled) {
              try { e.target.destroy() } catch { /* swallow */ }
              return
            }
            try {
              const dur = e.target.getDuration()
              if (dur > 0) {
                const clamped = Math.min(dur, 60 * 60)
                setTrackDuration(clamped)
                setClipEnd((prev) => Math.min(prev, clamped))
              }
            } catch {
              /* swallow */
            }
            try { e.target.destroy() } catch { /* swallow */ }
            if (container?.parentElement) {
              container.parentElement.removeChild(container)
              container = null
            }
          },
          onError: () => {
            try { player?.destroy() } catch { /* swallow */ }
            if (container?.parentElement) {
              container.parentElement.removeChild(container)
              container = null
            }
          },
        },
      })
    })()
    return () => {
      cancelled = true
      try { player?.destroy() } catch { /* swallow */ }
      if (container?.parentElement) {
        container.parentElement.removeChild(container)
      }
    }
  }, [editMode, draftMeta?.videoId, audioFile])

  async function analyse(): Promise<void> {
    if (!url.trim() || analysing) return
    setAnalysing(true)
    setAnalysisError(null)
    setDraftMeta(null)
    const res = await window.nexus.music.analyzeYouTube(url.trim())
    setAnalysing(false)
    if (!res.ok) {
      setAnalysisError(res.error)
      return
    }
    setDraftMeta(res.meta)
    // Switching to YouTube clears any in-flight audio upload — the
    // two sources are mutually exclusive.
    setAudioFile(null)
    setAudioUploadError(null)
    // Reset duration — oEmbed doesn't return it. The real value is
    // grabbed from MusicContext.duration via the effect below once
    // the user clicks Aperçu (the YT iframe needs to be live).
    setTrackDuration(DEFAULT_DURATION)
    setClipStart(0)
    setClipEnd(DEFAULT_DURATION)
  }

  function onFilePicked(file: File): void {
    if (file.size > MAX_AUDIO_BYTES) {
      setAudioUploadError(
        `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo, max 5 Mo)`,
      )
      return
    }
    setAudioUploadError(null)
    setAudioFile(file)
    // Switching to audio clears the URL + draft meta — same mutual-
    // exclusion logic as analyse(). The track preview card shows the
    // file name + size while the user adjusts the clip.
    setUrl('')
    setDraftMeta(null)
    setAnalysisError(null)
    setClipStart(0)
    setClipEnd(DEFAULT_DURATION)
    // Probe the real duration via a throwaway <audio>. Once it fires
    // 'loadedmetadata' we lock the slider's max onto the file length,
    // so a 3:18 mp3 doesn't get padded out to 5:00 like the screenshot
    // bug reported by the user.
    setTrackDuration(DEFAULT_DURATION)
    const probeUrl = URL.createObjectURL(file)
    const probe = new Audio()
    probe.preload = 'metadata'
    probe.addEventListener(
      'loadedmetadata',
      () => {
        if (!isNaN(probe.duration) && probe.duration > 0) {
          const dur = Math.min(probe.duration, 60 * 60) // hard-cap 1h
          setTrackDuration(dur)
          setClipEnd((prev) => Math.min(prev, dur))
        }
        URL.revokeObjectURL(probeUrl)
      },
      { once: true },
    )
    probe.addEventListener('error', () => URL.revokeObjectURL(probeUrl), { once: true })
    probe.src = probeUrl
  }

  async function save(): Promise<void> {
    if (!user?.id || saving) return
    // Sauvegarde permise si :
    //   - nouvelle source (draftMeta YouTube ou audioFile uploadé)
    //   - OU on édite cosmetics/clip d'une source DÉJÀ sauvegardée
    //     (savedAudioPath ou savedUrl). Sans ça, changer juste la
    //     plaque/effet sur un fichier audio renvoyait early et ne
    //     sauvait rien.
    if (!draftMeta && !audioFile && !savedAudioPath && !savedUrl) return
    // Tear down toute preview en cours — la sauvegarde déclenche un
    // refresh du display mode, et on veut pas qu'un audio orphelin
    // continue de jouer derrière.
    preview.stop()
    setSaving(true)

    let urlToSave: string | null = null
    let audioPathToSave: string | null = null

    if (audioFile) {
      // Upload first — if it fails, abort the save flow before
      // touching the cosmetics row.
      const buf = new Uint8Array(await audioFile.arrayBuffer())
      const up = await window.nexus.music.uploadAudio(
        user.id,
        audioFile.type || 'audio/mpeg',
        buf,
      )
      if (!up.ok) {
        setAudioUploadError(up.error)
        setSaving(false)
        return
      }
      audioPathToSave = up.relativePath
    } else if (draftMeta) {
      // Nouvelle URL OU URL inchangée (draftMeta a été cloné de
      // savedMeta dans startEdit). Dans tous les cas on persist le
      // contenu de `url` qui contient l'URL courante.
      urlToSave = url.trim() || savedUrl
    } else if (savedAudioPath) {
      // Pas de nouveau fichier mais on a une source audio
      // pré-existante — on la conserve pour ne pas wipe la musique
      // juste en éditant un cosmetic.
      audioPathToSave = savedAudioPath
    } else if (savedUrl) {
      // Idem pour une URL YouTube préexistante sans re-analyse.
      urlToSave = savedUrl
    }

    const res = await window.nexus.profile.updateCosmetics(user.id, {
      profileMusicUrl: urlToSave,
      profileMusicAudioPath: audioPathToSave,
      profileMusicStart: Math.floor(clipStart),
      profileMusicEnd: Math.floor(clipEnd),
      profileMusicPlaqueId: draftPlaqueId,
      profileMusicEffectId: draftEffectId,
    })
    setSaving(false)
    if (res?.ok) {
      setSavedUrl(urlToSave)
      setSavedAudioPath(audioPathToSave)
      setSavedStart(Math.floor(clipStart))
      setSavedEnd(Math.floor(clipEnd))
      setSavedMeta(draftMeta)
      setSavedPlaqueId(draftPlaqueId)
      setSavedEffectId(draftEffectId)
      setEditMode(false)
      setDraftMeta(null)
      setUrl('')
      setAudioFile(null)
    }
  }

  async function remove(): Promise<void> {
    if (!user?.id) return
    preview.stop()
    const res = await window.nexus.profile.updateCosmetics(user.id, {
      profileMusicUrl: null,
      profileMusicAudioPath: null,
      profileMusicStart: null,
      profileMusicEnd: null,
      profileMusicPlaqueId: null,
      profileMusicEffectId: null,
    })
    if (res?.ok) {
      setSavedUrl(null)
      setSavedAudioPath(null)
      setSavedMeta(null)
      setSavedStart(0)
      setSavedEnd(DEFAULT_DURATION)
      setSavedPlaqueId(null)
      setSavedEffectId(null)
    }
  }

  function startEdit(): void {
    setEditMode(true)
    setUrl(savedUrl ?? '')
    setAudioFile(null)
    setAudioUploadError(null)
    if (savedMeta) {
      setDraftMeta(savedMeta)
      setClipStart(savedStart)
      setClipEnd(savedEnd)
    } else if (savedAudioPath) {
      // Audio-only saved state — we don't have a File to re-edit, but
      // we can still surface the clip range + cosmetics for tweaking
      // by treating it like a fresh edit on top of the saved path.
      setClipStart(savedStart)
      setClipEnd(savedEnd)
    }
    setDraftPlaqueId(savedPlaqueId)
    setDraftEffectId(savedEffectId)
  }

  function cancelEdit(): void {
    preview.stop()
    setEditMode(false)
    setUrl('')
    setDraftMeta(null)
    setAudioFile(null)
    setAnalysisError(null)
    setAudioUploadError(null)
    setDraftPlaqueId(null)
    setDraftEffectId(null)
  }

  function previewClip(): void {
    // Toggle — si on preview déjà, le clic arrête. Sinon on lance
    // avec la source dispo (YouTube draft ou fichier local).
    if (preview.previewing) {
      preview.stop()
      return
    }
    if (draftMeta) {
      void preview.start(
        { kind: 'youtube', videoId: draftMeta.videoId },
        clipStart,
        clipEnd,
      )
    } else if (audioFile) {
      void preview.start(
        { kind: 'audio-blob', blob: audioFile },
        clipStart,
        clipEnd,
      )
    }
  }

  function playSaved(): void {
    if (savedAudioPath) {
      void playAudio(
        savedAudioPath,
        {
          title: savedMeta?.title ?? 'Fichier audio',
          artist: savedMeta?.author ?? null,
          albumArt: upgradeYouTubeThumbnail(savedMeta?.thumbnail) || null,
        },
        { start: savedStart, end: savedEnd },
      )
    } else if (savedUrl) {
      void playUrl(savedUrl, { start: savedStart, end: savedEnd })
    }
  }

  if (!user) return null

  const hasSaved = !!(savedUrl || savedAudioPath)
  const hasDraft = !!(draftMeta || audioFile)

  // ── DISPLAY MODE ─────────────────────────────────────────────
  if (hasSaved && !editMode) {
    return (
      <Card padding="md">
        <h2 className="font-semibold text-sm text-fg-primary mb-1 flex items-center gap-2">
          <Music className="w-4 h-4 text-emerald-400" />
          Musique de profil
        </h2>
        <p className="text-xs text-fg-muted mb-4">
          Joue en boucle quand un visiteur ouvre ton profil.
        </p>

        <div className="flex items-center gap-4 mb-4">
          {savedMeta?.thumbnail ? (
            // Wrapper + img absolute : le preflight Tailwind force
            // `img { max-width: 100%; height: auto }`, ce qui étire
            // l'image YouTube (16:9) à 56×31 avec bandes noires en
            // dessous quand on lui demande un carré. Inline `maxWidth /
            // maxHeight: none` sur l'img n'est PAS assez ici (Tailwind
            // applique la règle via une cascade plus haute) — la seule
            // façon fiable est d'envelopper dans un wrapper avec
            // overflow:hidden + l'img en absolute inset:0 qui CROP le
            // surplus.
            <div
              className="rounded-xl overflow-hidden shrink-0 relative"
              style={{ width: 56, height: 56 }}
            >
              <img
                src={upgradeYouTubeThumbnail(savedMeta.thumbnail)}
                alt=""
                draggable={false}
                onError={(e) => {
                  // Fallback maxresdefault → mqdefault pour les
                  // vidéos qui n'ont pas de version HD (uploads
                  // pré-2017). mqdefault est aussi un vrai 16:9 sans
                  // bandes noires baked-in — pas hqdefault qui les
                  // ramènerait.
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
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
              />
            </div>
          ) : (
            <div
              className="rounded-xl flex items-center justify-center shrink-0 bg-accent-primary/30"
              style={{ width: 56, height: 56 }}
            >
              <Music className="w-6 h-6 text-accent-primary" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="font-bold text-sm truncate text-fg-primary">
              {savedMeta?.title ?? (savedAudioPath ? 'Fichier audio' : 'Piste')}
            </p>
            {savedMeta?.author && (
              <p className="text-xs truncate mt-0.5 text-fg-muted">
                {savedMeta.author}
              </p>
            )}
            <p className="text-[11px] font-mono mt-1 text-fg-faint">
              Extrait : {fmt(savedStart)} — {fmt(savedEnd)}
              <span className="opacity-70">
                {' '}
                ({fmt(savedEnd - savedStart)})
              </span>
            </p>
          </div>
        </div>

        <Button
          onClick={playSaved}
          leftIcon={<Play className="w-3.5 h-3.5" />}
          fullWidth
          className="mb-4"
        >
          Écouter sur le lecteur
        </Button>

        {/* Mini player preview WITH plaque + effect — donne au user
            un aperçu fidèle du HUD étendu (animation du lecteur
            étendu superposée à la plaque). ScanVerse parity. */}
        <MiniPlayerPreview
          plaqueId={savedPlaqueId}
          albumArt={upgradeYouTubeThumbnail(savedMeta?.thumbnail) || null}
          title={savedMeta?.title ?? (savedAudioPath ? 'Fichier audio' : 'Piste')}
        />

        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <Button
            variant="outline"
            onClick={startEdit}
            leftIcon={<Pencil className="w-3.5 h-3.5" />}
            className="flex-1"
          >
            Modifier
          </Button>
          <Button
            variant="ghost"
            onClick={() => void remove()}
            leftIcon={<Trash2 className="w-3.5 h-3.5" />}
            className="flex-1 text-error hover:bg-error/10"
          >
            Supprimer
          </Button>
        </div>
      </Card>
    )
  }

  // ── EDIT MODE (add or modify) ────────────────────────────────
  return (
    <Card padding="md">
      <h2 className="font-semibold text-sm text-fg-primary mb-1 flex items-center gap-2">
        <Music className="w-4 h-4 text-emerald-400" />
        {hasSaved ? 'Modifier la musique du profil' : 'Ajouter une musique'}
      </h2>
      <p className="text-xs text-fg-muted mb-5">
        Joue en boucle quand un visiteur ouvre ton profil.
      </p>

      {/* Step 1 — URL paste + Analyser */}
      <div className="mb-5">
        <label className="block text-[11px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
          1 · Colle un lien YouTube
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setDraftMeta(null)
              setAnalysisError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void analyse()}
            placeholder="https://youtube.com/watch?v=… ou https://youtu.be/…"
            className="flex-1 h-11 px-4 rounded-md text-sm outline-none bg-surface-soft border border-glass-border focus:border-accent-primary/60 text-fg-primary placeholder:text-fg-muted transition-colors"
          />
          <Button
            onClick={() => void analyse()}
            loading={analysing}
            disabled={!url.trim()}
          >
            Analyser
          </Button>
        </div>
        {analysisError && (
          <p className="text-xs mt-1.5 text-error">{analysisError}</p>
        )}
        <p className="text-xs mt-1.5 text-fg-faint">
          OST, openings, edits, AMV — copie l'URL YouTube. L'audio est lu
          via le lecteur intégré, pas téléchargé.
        </p>
      </div>

      {/* Step 1-bis — OR / file upload (ScanVerse parity) */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-1 h-px bg-border-soft" />
          <span className="text-[11px] font-mono text-fg-faint">OU</span>
          <div className="flex-1 h-px bg-border-soft" />
        </div>
        <label className="block text-[11px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
          Importer un fichier audio
        </label>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all bg-surface-soft border border-dashed border-glass-border hover:bg-surface-soft-hover hover:border-accent-primary/40 text-fg-secondary"
          style={{ minHeight: 48 }}
        >
          <Upload className="w-4 h-4" />
          {audioFile
            ? `${audioFile.name} — ${(audioFile.size / 1024 / 1024).toFixed(2)} Mo`
            : 'Choisir un fichier MP3, WAV, M4A ou OGG (max 5 Mo)'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,audio/wav,audio/wave,audio/x-wav,audio/mp4,audio/m4a,audio/x-m4a,audio/ogg,audio/opus,audio/webm"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFilePicked(f)
            // Reset the input so the same file can be re-picked.
            e.target.value = ''
          }}
        />
        {audioUploadError && (
          <p className="text-xs mt-1.5 text-error">{audioUploadError}</p>
        )}
        <p className="text-xs mt-1.5 text-fg-faint">
          Pas de YouTube ? Importe directement ton MP3 / WAV. Stocké
          localement, jamais envoyé en ligne.
        </p>
      </div>

      {/* Step 2 — track preview */}
      {(draftMeta || audioFile) && (
        <div className="mb-5">
          <label className="block text-[11px] font-mono uppercase tracking-wider mb-2 text-fg-muted">
            2 · Infos de la piste
          </label>
          <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-soft border border-glass-border">
            {draftMeta ? (
              // Wrapper + img absolute pour bypasser le preflight
              // Tailwind `img { height: auto }` qui dégrade le crop
              // en bandes noires sur une 16:9 (YouTube) affichée en carré.
              <div
                className="rounded-lg overflow-hidden shrink-0 relative"
                style={{ width: 44, height: 44 }}
              >
                <img
                  src={upgradeYouTubeThumbnail(draftMeta.thumbnail)}
                  alt=""
                  draggable={false}
                  onError={(e) => {
                    // Fallback maxresdefault → mqdefault si pas dispo
                    // (uploads non-HD pré-2017). mqdefault est aussi
                    // une vraie 16:9 sans bandes noires baked-in.
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
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }}
                />
              </div>
            ) : (
              <div
                className="rounded-lg flex items-center justify-center shrink-0 bg-accent-primary/30"
                style={{ width: 44, height: 44 }}
              >
                <Music className="w-5 h-5 text-accent-primary" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-fg-primary truncate">
                {draftMeta?.title ?? audioFile?.name ?? 'Sans titre'}
              </p>
              <p className="text-xs text-fg-muted truncate">
                {draftMeta?.author ??
                  (audioFile ? 'Fichier local' : '—')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Step 3 — clip slider + precision inputs (parité ScanVerse) */}
      {(draftMeta || audioFile) && (
        <div className="mb-5">
          <label className="block text-[11px] font-mono uppercase tracking-wider mb-1 text-fg-muted">
            3 · Sélectionne la tranche (max 5 min)
          </label>
          <p className="text-xs mb-3 text-fg-faint">
            Glisse les curseurs pour définir le début et la fin de l'extrait.
          </p>
          <DualRangeSlider
            min={0}
            max={trackDuration}
            start={clipStart}
            end={Math.min(clipEnd, trackDuration)}
            maxWindow={CLIP_MAX_WINDOW}
            onChange={(s, e) => {
              setClipStart(s)
              setClipEnd(e)
            }}
            isPreviewing={preview.previewing}
            previewTime={preview.previewing ? preview.previewTime : null}
          />

          {/* Triplet sous le slider — labels minutes:secondes en gros
              avec le sous-titre Début / Durée / Fin (parité ScanVerse). */}
          <div className="grid grid-cols-3 gap-2 mt-3 px-0.5">
            <div className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-mono font-bold text-accent-primary">
                {fmt(clipStart)}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                Début
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-sm font-mono font-bold text-fg-primary">
                {(Math.min(clipEnd, trackDuration) - clipStart).toFixed(1)}s
              </span>
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                Durée
              </span>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-sm font-mono font-bold text-accent-primary">
                {fmt(Math.min(clipEnd, trackDuration))}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                Fin
              </span>
            </div>
          </div>

          {/* Précision seconde — inputs numériques pour caler l'extrait
              au dixième de seconde près. ScanVerse utilise step 0.1 :
              assez fin pour un drop musical, pas trop pour rester
              cliquable. Le décimal `,` français est accepté en saisie
              et converti via parseFloat (qui tolère les deux). */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <PrecisionInput
              label="Début (s)"
              value={clipStart}
              max={Math.min(clipEnd, trackDuration) - 0.5}
              onChange={(v) => {
                const next = Math.max(0, Math.min(v, Math.min(clipEnd, trackDuration) - 0.5))
                setClipStart(Math.round(next * 10) / 10)
              }}
            />
            <PrecisionInput
              label="Fin (s)"
              value={Math.min(clipEnd, trackDuration)}
              max={trackDuration}
              onChange={(v) => {
                const next = Math.max(clipStart + 0.5, Math.min(v, trackDuration))
                setClipEnd(Math.round(next * 10) / 10)
              }}
            />
          </div>

          <Button
            variant={preview.previewing ? 'danger' : 'outline'}
            onClick={previewClip}
            leftIcon={
              preview.previewing ? (
                <Square className="w-3.5 h-3.5 fill-current" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current" />
              )
            }
            fullWidth
            className="mt-4"
          >
            {preview.previewing
              ? 'Arrêter la prévisualisation'
              : 'Prévisualiser la sélection'}
          </Button>
        </div>
      )}

      {/* Step 4 — Plaque animée du lecteur */}
      <div className="mb-5">
        <label className="block text-[11px] font-mono uppercase tracking-wider mb-2 text-fg-muted">
          Plaque animée du lecteur
        </label>
        <PlaqueQuickGrid
          currentId={draftPlaqueId}
          onPick={setDraftPlaqueId}
          onSeeAll={() => setPlaqueModalOpen(true)}
        />

        {/* Mini player preview avec la plaque sélectionnée — c'est
            exactement ce que verra un visiteur quand il écoutera ce
            profil dans la HUD musique étendue. */}
        <div className="mt-3">
          <MiniPlayerPreview
            plaqueId={draftPlaqueId}
            albumArt={upgradeYouTubeThumbnail(draftMeta?.thumbnail) || null}
            title={draftMeta?.title ?? audioFile?.name ?? 'Titre de la piste'}
          />
          <p className="text-xs mt-1.5 text-fg-faint">
            {draftPlaqueId
              ? 'Aperçu du lecteur avec la plaque sélectionnée.'
              : 'Aperçu sans plaque.'}
          </p>
        </div>
      </div>

      {/* Step 5 — Animation du lecteur étendu */}
      <div className="mb-5">
        <label className="block text-[11px] font-mono uppercase tracking-wider mb-2 text-fg-muted">
          Animation du lecteur étendu
        </label>
        <div className="flex flex-col sm:flex-row sm:items-stretch gap-2">
          <div
            className="flex-1 rounded-xl px-3 py-2 flex items-center gap-2 bg-surface-soft border border-glass-border"
            style={{ minHeight: 44 }}
          >
            {(() => {
              const fx = draftEffectId ? PROFILE_EFFECTS_BY_ID[draftEffectId] : null
              return fx ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-accent-primary shrink-0" />
                  <span className="text-xs font-semibold text-fg-primary truncate flex-1">
                    {fx.name}
                  </span>
                  <span className="text-[10px] font-mono text-fg-muted shrink-0">
                    {fx.parts.length} couche{fx.parts.length > 1 ? 's' : ''}
                  </span>
                </>
              ) : (
                <span className="text-xs italic text-fg-muted">
                  Aucune animation sélectionnée
                </span>
              )
            })()}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => setEffectModalOpen(true)}
              className="flex-1 sm:flex-initial"
            >
              Choisir
            </Button>
            {draftEffectId && (
              <button
                type="button"
                onClick={() => setDraftEffectId(null)}
                aria-label="Retirer l'animation"
                className="px-3 rounded-md bg-surface-soft border border-glass-border text-fg-muted hover:text-error hover:border-error/40 transition-colors"
                style={{ minHeight: 44 }}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Save / Annuler */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          onClick={() => void save()}
          loading={saving}
          disabled={!hasDraft}
          className="flex-1"
        >
          Enregistrer
        </Button>
        {hasSaved && (
          <Button variant="outline" onClick={cancelEdit} className="flex-1">
            Annuler
          </Button>
        )}
      </div>

      {/* Full-catalogue modals — `previewTrack` propage la track en
          cours d'édition vers la preview de droite pour que l'user voie
          SA musique derrière la plaque (au lieu du placeholder bidon). */}
      <MusicCosmeticsModal
        open={plaqueModalOpen}
        onClose={() => setPlaqueModalOpen(false)}
        kind="plaque"
        currentId={draftPlaqueId}
        previewTrack={
          draftMeta
            ? { title: draftMeta.title, albumArt: upgradeYouTubeThumbnail(draftMeta.thumbnail) }
            : audioFile
              ? { title: audioFile.name, albumArt: null }
              : null
        }
        onPick={(id) => {
          setDraftPlaqueId(id)
          setPlaqueModalOpen(false)
        }}
      />
      <MusicCosmeticsModal
        open={effectModalOpen}
        onClose={() => setEffectModalOpen(false)}
        kind="effect"
        currentId={draftEffectId}
        previewTrack={
          draftMeta
            ? { title: draftMeta.title, albumArt: upgradeYouTubeThumbnail(draftMeta.thumbnail) }
            : audioFile
              ? { title: audioFile.name, albumArt: null }
              : null
        }
        onPick={(id) => {
          setDraftEffectId(id)
          setEffectModalOpen(false)
        }}
      />
    </Card>
  )
}

/* ───────────────── PrecisionInput ───────────────── */

interface PrecisionInputProps {
  label: string
  value: number
  /** Plafond cliquable. Sert juste à clamper l'affichage — la
   *  validation finale se fait dans `onChange` du parent. */
  max: number
  onChange: (v: number) => void
}

/** Input numérique au dixième de seconde près. Accepte `,` comme
 *  séparateur décimal (parseFloat le tolère). Le label est rendu en
 *  uppercase mono au-dessus pour matcher le pattern ScanVerse. */
function PrecisionInput({ label, value, onChange }: PrecisionInputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-mono uppercase tracking-wider text-fg-muted">
        {label}
      </label>
      <input
        type="number"
        step={0.1}
        min={0}
        // value affiché avec 1 décimale ; on remplace ',' par '.' au
        // parseFloat parce que les inputs number en FR acceptent
        // parfois la virgule, parfois non selon le browser.
        value={value.toFixed(1)}
        onChange={(e) => {
          const raw = e.target.value.replace(',', '.')
          const parsed = parseFloat(raw)
          if (!isNaN(parsed)) onChange(parsed)
        }}
        className="h-11 px-3.5 rounded-md text-sm font-mono outline-none bg-surface-soft border border-glass-border focus:border-accent-primary/60 text-fg-primary transition-colors"
      />
    </div>
  )
}

/* ───────────────── PlaqueQuickGrid ───────────────── */

interface PlaqueQuickGridProps {
  currentId: string | null
  onPick: (id: string | null) => void
  onSeeAll: () => void
}

/** Grid 3 cols mobile / 5 cols desktop, 10 cells :
 *   [Aucune] + 8 quick picks + [+] (ouvre la modale).
 *  Quick picks = les 8 premières plaques alphabétiquement, ou la
 *  sélection actuelle en tête si elle sort de la fenêtre. */
function PlaqueQuickGrid({ currentId, onPick, onSeeAll }: PlaqueQuickGridProps) {
  if (NAMEPLATES.length === 0) {
    return (
      <p className="text-xs text-fg-muted">Aucune plaque disponible.</p>
    )
  }

  const firstN = NAMEPLATES.slice(0, PLAQUE_QUICK_PICKS)
  const selectedInFirstN =
    !currentId || firstN.some((p) => p.id === currentId)
  let quickPicks = firstN
  if (!selectedInFirstN) {
    const selected = NAMEPLATES.find((p) => p.id === currentId)
    if (selected) {
      // Pin the current selection to the head + drop the last pick to
      // keep the cell count constant.
      quickPicks = [selected, ...firstN.slice(0, PLAQUE_QUICK_PICKS - 1)]
    }
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
      {/* Cell 0 — Aucune */}
      <button
        onClick={() => onPick(null)}
        className={cn(
          'h-11 rounded-lg text-[11px] font-semibold transition-all active:scale-95',
          !currentId
            ? 'bg-accent-primary text-white border border-accent-primary'
            : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30',
        )}
      >
        Aucune
      </button>

      {/* Cells 1-8 — quick picks */}
      {quickPicks.map((p) => (
        <PlaqueTileButton
          key={p.id}
          plaque={p}
          isActive={currentId === p.id}
          onClick={() => onPick(p.id)}
        />
      ))}

      {/* Cell 9 — "+" opens MusicCosmeticsModal */}
      <button
        onClick={onSeeAll}
        title="Voir toutes les plaques"
        className="h-11 rounded-lg flex items-center justify-center gap-1 transition-all active:scale-95 bg-accent-primary/10 border border-dashed border-accent-primary/40 text-accent-primary hover:bg-accent-primary/20 hover:border-accent-primary/60"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
        <span className="text-[10px] font-bold font-mono tracking-wider">
          {NAMEPLATES.length}
        </span>
      </button>
    </div>
  )
}

function PlaqueTileButton({
  plaque,
  isActive,
  onClick,
}: {
  plaque: Nameplate
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={plaque.name}
      className={cn(
        'relative h-11 rounded-lg overflow-hidden p-0 transition-all',
        isActive
          ? 'ring-2 ring-accent-primary scale-[1.03]'
          : 'border border-glass-border hover:border-accent-primary/40',
      )}
      style={{ background: '#0e0e15' }}
    >
      <video
        src={plaque.file}
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0 }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background:
            plaque.gradientCss ??
            'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
        }}
      />
      <div
        className="relative z-10 flex items-center gap-1.5 px-2 h-full"
      >
        {plaque.lightHex && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: plaque.lightHex,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            }}
          />
        )}
        <span
          className="text-[10px] font-semibold text-white truncate"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}
        >
          {plaque.name}
        </span>
      </div>
    </button>
  )
}

/* ───────────────── MiniPlayerPreview ───────────────── */

interface MiniPlayerPreviewProps {
  plaqueId: string | null
  albumArt: string | null
  title: string
}

/** Aperçu compact du MiniPlayer réel — plaque animée + cover + titre,
 *  PAS d'effet (parité avec le composant MiniPlayer en production qui
 *  réserve l'effet à l'ExtendedPlayer uniquement). Avant, on stackait
 *  l'effet par-dessus la plaque sur un preview de 52 px de haut →
 *  l'effet débordait sur le texte, illisible, et donnait l'impression
 *  d'un rendu "bugué" alors que c'était juste une représentation
 *  fausse du HUD final. L'effet vit dans son propre EffectPreview au
 *  sein du picker dédié. */
function MiniPlayerPreview({
  plaqueId,
  albumArt,
  title,
}: MiniPlayerPreviewProps) {
  const plaque = plaqueId ? NAMEPLATES.find((p) => p.id === plaqueId) : null
  return (
    <div
      className="rounded-xl overflow-hidden relative bg-bg-primary border border-glass-border"
      style={{ height: 52, backdropFilter: 'blur(14px)' }}
    >
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
                'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
            }}
          />
        </>
      )}
      <div
        className="relative flex items-center gap-2 px-3 h-full"
        style={{ zIndex: 100 }}
      >
        <div
          className="rounded shrink-0 overflow-hidden bg-surface-medium relative"
          style={{ width: 32, height: 32 }}
        >
          {albumArt && (
            <img
              src={albumArt}
              alt=""
              draggable={false}
              onError={(e) => {
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
                maxWidth: 'none',
                maxHeight: 'none',
              }}
            />
          )}
        </div>
        <span
          className="text-[11px] flex-1 truncate"
          style={{
            color: plaque ? '#fff' : 'var(--text-secondary)',
            textShadow: plaque ? '0 1px 2px rgba(0,0,0,0.8)' : undefined,
          }}
        >
          {title}
        </span>
        <Music
          className="w-3.5 h-3.5 text-accent-primary shrink-0"
          aria-hidden
        />
        <Play
          className="w-3.5 h-3.5 fill-white text-white shrink-0"
          aria-hidden
        />
      </div>
    </div>
  )
}
