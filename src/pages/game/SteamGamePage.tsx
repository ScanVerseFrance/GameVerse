/**
 * `/steam-game/:appid` — the canonical game page, keyed by Steam appid.
 *
 * Renders the FULL Hydra-style rich layout (cover hero, meta side
 * panel, achievements, HLTB, news, reviews) for EVERY catalogue
 * entry — whether or not an imported JSON source ships it. This
 * replaces the old "minimal page when no source" fallback the user
 * complained about (GTA V landing on an ugly placeholder).
 *
 * Source picker (download options) appears when at least one JSON
 * source has resolved to this appid; otherwise we show an "Aucune
 * source" notice. The page itself stays identical so the user gets
 * the same UX everywhere.
 *
 * Crucially: we NEVER redirect to /json-game/{id}. The old redirect
 * meant clicking "Call of Duty: Modern Warfare II" (correctly listed
 * in Top Owned by appid 1938090) landed on whatever JSON source had
 * been mis-resolved to that appid — e.g. "Call of Duty (2003)".
 * The new behaviour shows MW2's actual cover + meta and lists the
 * source as a download option, even if the source itself is
 * mis-resolved upstream.
 */
import { useEffect, useMemo, useState } from 'react'
import { useParams, Link, Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Download as DownloadIcon,
  Star,
  FileJson,
  HardDrive,
  Calendar,
  Users,
  Gamepad2,
  Trophy,
  Lock,
} from '@/lib/icons'
import { motion } from 'framer-motion'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SteamMetaSection } from '@/components/game/SteamMetaSection'
import { SteamNewsSection } from '@/components/game/SteamNewsSection'
import { HowLongToBeatSection } from '@/components/game/HowLongToBeatSection'
import { StarRating } from '@/components/reviews/StarRating'
import { useAuthStore } from '@/stores/auth.store'
import { useCommentsStore } from '@/stores/comments.store'

type Detail = {
  appid: number
  name: string
  ownersRank: number
  scoreRank: number
  downloadCount: number
  ratingAvg: number | null
  ratingCount: number
  sources: Array<{
    gameId: string
    sourceId: string
    sourceName: string
    title: string
    uris: string[]
    fileSize: string | null
    uploadDate: string | null
  }>
}

export default function SteamGamePage() {
  const { appid: appidParam } = useParams<{ appid: string }>()
  const appid = Number.parseInt(appidParam ?? '0', 10)
  const navigate = useNavigate()
  /** Retour back-in-history avec fallback /discover quand entrée
   *  directe via URL (history.length <= 1). v0.5.1. */
  function goBack(): void {
    if (window.history.length > 1) navigate(-1)
    else navigate('/discover')
  }

  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [coverStage, setCoverStage] = useState<'library' | 'header' | 'capsule' | 'placeholder'>('library')
  const [copiedUri, setCopiedUri] = useState<string | null>(null)

  // Pulled-from-catalogue hero backdrop. Falls back through the
  // same chain SteamCatalogueTile uses for tile thumbnails.
  const [bannerStage, setBannerStage] = useState<'hero' | 'header' | 'failed'>('hero')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    if (!Number.isFinite(appid) || appid <= 0) {
      setDetail(null)
      setLoading(false)
      return
    }
    void window.nexus.steamCatalogue.get(appid).then((res) => {
      if (cancelled) return
      if (res.ok) setDetail(res.detail as Detail)
      else setDetail(null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [appid])

  // ── Helpers ────────────────────────────────────────────────────
  const cover = useMemo(() => {
    if (coverStage === 'library') {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`
    }
    if (coverStage === 'header') {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
    }
    if (coverStage === 'capsule') {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`
    }
    return null
  }, [appid, coverStage])

  function handleCoverError() {
    if (coverStage === 'library') setCoverStage('header')
    else if (coverStage === 'header') setCoverStage('capsule')
    else if (coverStage === 'capsule') setCoverStage('placeholder')
  }

  const banner = useMemo(() => {
    if (bannerStage === 'hero') {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`
    }
    if (bannerStage === 'header') {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
    }
    return null
  }, [appid, bannerStage])

  function handleBannerError() {
    if (bannerStage === 'hero') setBannerStage('header')
    else setBannerStage('failed')
  }

  async function copyUri(uri: string) {
    await window.nexus.jsonSources.copyMagnet(uri)
    setCopiedUri(uri)
    setTimeout(() => setCopiedUri(null), 1500)
  }

  // ── Reviews — game_comments keyed by appid ─────────────────────
  const user = useAuthStore((s) => s.user)
  const loadComments = useCommentsStore((s) => s.load)
  useEffect(() => {
    if (!appid) return
    // Reuse the existing comments pipeline. The reviews backing
    // table is keyed by (game_kind, game_external_id) — for the
    // Steam-game entry point we use kind='steam' + appid as id.
    void loadComments('steam', String(appid))
  }, [appid, loadComments])

  // ── Achievements — Steam Web API + storefront fallback ────────
  // Mirrors the JsonGamePage pipeline. The achievement watcher
  // backfills unlock state once the user launches the game; here
  // we just surface the catalog so they know what's possible.
  type AchVM = {
    apiName: string
    displayName: string
    description: string | null
    iconUrl: string | null
    iconGrayUrl: string | null
    hidden: boolean
    unlockedAt: number | null
  }
  const [achievements, setAchievements] = useState<AchVM[]>([])
  const [achievementsLoading, setAchievementsLoading] = useState(false)
  const [achievementsTotal, setAchievementsTotal] = useState(0)
  const [achievementsModalOpen, setAchievementsModalOpen] = useState(false)
  const ACHIEVEMENTS_SIDEBAR_LIMIT = 10

  useEffect(() => {
    if (!user || !appid || appid <= 0) {
      setAchievements([])
      setAchievementsTotal(0)
      return
    }
    let cancelled = false
    setAchievementsLoading(true)
    void window.nexus.achievements
      .listForGame(user.id, appid)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setAchievements(res.achievements as AchVM[])
          setAchievementsTotal(
            (res as { total?: number }).total ?? res.achievements.length,
          )
        } else {
          setAchievements([])
        }
        setAchievementsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, appid])

  // ── Render gate ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <LoadingSpinner />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-accent-primary mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Retour
        </button>
        <Card padding="lg" className="text-center">
          <p className="text-fg-muted">
            Jeu introuvable dans le catalogue Steam (appid {appid}).
          </p>
        </Card>
      </div>
    )
  }

  // When the catalogue entry has at least one matched JSON source,
  // redirect to the existing rich JsonGamePage so the user gets the
  // full UX they expect (source picker with recommended marker,
  // achievement modal with locked icons, review composer with stars
  // + spoiler tags, install/uninstall flow, etc.). The earlier
  // wrong-redirect bug (MW2 → CoD 2003) was caused by mis-resolved
  // source appids, which the catalogue-cleanup pass purged. We can
  // safely redirect again.
  if (detail.sources.length > 0) {
    return (
      <Navigate
        to={`/json-game/${encodeURIComponent(detail.sources[0]!.gameId)}`}
        replace
      />
    )
  }

  const hasSources = false
  const totalSize = detail.sources.reduce((sum, s) => {
    if (!s.fileSize) return sum
    return sum + 1
  }, 0)
  void totalSize

  return (
    <div>
      {/* ── HERO STRIP ──────────────────────────────────────────── */}
      <div className="relative w-full h-[280px] md:h-[340px] overflow-hidden bg-bg-tertiary">
        {banner ? (
          <img
            src={banner}
            alt=""
            onError={handleBannerError}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-bg-tertiary via-bg-secondary to-bg-primary" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/70 to-transparent" />

        <div className="absolute top-4 left-4 z-10">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/40 hover:bg-black/70 backdrop-blur-sm text-sm text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Retour
          </button>
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-6 lg:p-10 max-w-[1600px] mx-auto">
          <div className="flex items-end gap-5">
            <div className="w-28 h-40 md:w-36 md:h-52 rounded-lg overflow-hidden border-2 border-glass-border shadow-2xl bg-bg-tertiary shrink-0">
              {cover ? (
                <img
                  src={cover}
                  alt={detail.name}
                  onError={handleCoverError}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Gamepad2 className="w-10 h-10 text-fg-muted" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0 pb-2">
              <h1 className="font-display font-bold text-2xl md:text-4xl text-fg-primary leading-tight drop-shadow-xl">
                {detail.name}
              </h1>
              <div className="flex items-center gap-3 mt-2 text-xs text-fg-secondary flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-bg-tertiary/80 backdrop-blur-sm border border-glass-border">
                  Steam appid <code className="text-fg-primary">{detail.appid}</code>
                </span>
                {detail.ownersRank > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="w-3 h-3" />
                    ≥ {detail.ownersRank.toLocaleString('fr-FR')} possesseurs
                  </span>
                )}
                {detail.downloadCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-accent-primary">
                    <DownloadIcon className="w-3 h-3" />
                    {detail.downloadCount.toLocaleString('fr-FR')} via Nexus
                  </span>
                )}
                {detail.ratingAvg !== null && detail.ratingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-amber-300">
                    <StarRating value={detail.ratingAvg} readonly size="sm" />
                    {detail.ratingAvg.toFixed(1)} ({detail.ratingCount} avis)
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 lg:px-10 max-w-[1600px] mx-auto pt-6">
        <a
          href={`https://store.steampowered.com/app/${detail.appid}/`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent-primary hover:underline mb-4"
        >
          <ExternalLink className="w-4 h-4" /> Page Steam Store
        </a>

        {/* ── MAIN CONTENT GRID ─────────────────────────────────── */}
        <div className="grid lg:grid-cols-[1fr_360px] gap-6 pb-12">
          <div className="min-w-0">
            {/* Source picker section */}
            <motion.section
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="mb-6"
            >
              <h2 className="text-sm font-bold uppercase tracking-widest text-fg-secondary mb-3 inline-flex items-center gap-2">
                <FileJson className="w-3.5 h-3.5 text-accent-primary" />
                Sources de téléchargement
                {hasSources && (
                  <span className="text-fg-muted font-normal normal-case lowercase">
                    · {detail.sources.length}
                  </span>
                )}
              </h2>
              {!hasSources ? (
                <Card padding="lg" className="border-dashed">
                  <h3 className="text-base font-semibold mb-2">
                    Aucune source téléchargeable
                  </h3>
                  <p className="text-sm text-fg-muted">
                    Aucun catalogue JSON importé ne propose ce jeu pour l'instant.
                    Importez une source (FitGirl, AnkerGames, DODI…) depuis
                    Paramètres → Catalogues pour voir apparaître ici les liens.
                  </p>
                </Card>
              ) : (
                <Card padding="md">
                  <div className="space-y-2">
                    {detail.sources.map((s) => (
                      <div
                        key={s.gameId}
                        className="rounded-lg border border-glass-border bg-bg-secondary p-3 flex items-start gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent-primary/20 text-accent-primary">
                              {s.sourceName}
                            </span>
                            {s.fileSize && (
                              <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                                <HardDrive className="w-3 h-3" />
                                {s.fileSize}
                              </span>
                            )}
                            {s.uploadDate && (
                              <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                                <Calendar className="w-3 h-3" />
                                {s.uploadDate}
                              </span>
                            )}
                          </div>
                          <p
                            className="text-sm text-fg-primary truncate"
                            title={s.title}
                          >
                            {s.title}
                          </p>
                          {s.uris.length === 0 ? (
                            <p className="text-xs text-fg-muted italic mt-1">
                              Aucun lien dans cette entrée.
                            </p>
                          ) : (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {s.uris.map((u, i) => (
                                <Button
                                  key={i}
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => copyUri(u)}
                                  className="text-xs"
                                >
                                  {copiedUri === u ? (
                                    'Copié !'
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3 mr-1" />
                                      Lien {i + 1}
                                    </>
                                  )}
                                </Button>
                              ))}
                            </div>
                          )}
                        </div>
                        <Link
                          to={`/json-game/${encodeURIComponent(s.gameId)}`}
                          className="text-fg-muted hover:text-accent-primary shrink-0"
                          title="Voir la page complète de cette variante"
                        >
                          <DownloadIcon className="w-5 h-5" />
                        </Link>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </motion.section>

            {/* Steam meta — config requise + categories body */}
            <SteamMetaSection steamAppId={appid} bodyOnly />

            {/* Achievements — same look as JsonGamePage: locked icons
                grayscale+lock-overlay, "Voir tous" modal, AchievementCard
                shared component. */}
            {(achievements.length > 0 || achievementsLoading) && (
              <section className="mb-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-fg-secondary mb-3 inline-flex items-center gap-2">
                  <Trophy className="w-3.5 h-3.5 text-amber-300" />
                  Succès
                  {achievementsTotal > 0 && (
                    <span className="text-fg-muted font-normal normal-case lowercase">
                      · {achievementsTotal}
                    </span>
                  )}
                </h2>
                <Card padding="lg">
                  {achievementsLoading ? (
                    <div className="py-4 text-center text-sm text-fg-muted inline-flex items-center justify-center w-full gap-2">
                      <LoadingSpinner size="sm" /> Chargement des succès…
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {achievements
                          .slice(0, ACHIEVEMENTS_SIDEBAR_LIMIT)
                          .map((a) => (
                            <SteamAchievementCard key={a.apiName} achievement={a} />
                          ))}
                      </div>
                      {achievements.length > ACHIEVEMENTS_SIDEBAR_LIMIT && (
                        <button
                          type="button"
                          onClick={() => setAchievementsModalOpen(true)}
                          className="mt-3 w-full h-10 rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/40 text-sm font-semibold text-fg-primary inline-flex items-center justify-center gap-2 transition-colors"
                        >
                          <Trophy className="w-3.5 h-3.5 text-accent-primary" />
                          Voir tous les succès ·{' '}
                          {achievementsTotal || achievements.length}
                        </button>
                      )}
                      <p className="text-[11px] text-fg-muted mt-3 leading-relaxed">
                        <Trophy className="inline w-3 h-3 mr-1 -mt-0.5" />
                        Les succès se débloquent automatiquement quand le jeu
                        est lancé via Nexus — le watcher d'achievements scrute
                        les fichiers de save des principales releases.
                      </p>
                    </>
                  )}
                </Card>
              </section>
            )}

            {/* News */}
            <details className="mb-6 group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-fg-secondary hover:text-fg-primary transition-colors py-2 px-1 inline-flex items-center gap-2">
                <span>Actualités Steam</span>
                <span className="text-fg-muted group-open:rotate-90 transition-transform">
                  ▸
                </span>
              </summary>
              <div className="mt-2">
                <SteamNewsSection steamAppId={appid} />
              </div>
            </details>

            {/* Reviews — placeholder section. The full review composer
                lives on /json-game/{id}; here we just nudge the user
                toward installing a source if they want to write one. */}
            {detail.ratingCount > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-fg-secondary mb-3 inline-flex items-center gap-2">
                  <Star className="w-3.5 h-3.5 text-amber-300" />
                  Avis Nexus · {detail.ratingCount}
                </h2>
                <Card padding="lg">
                  <div className="flex items-center gap-3">
                    <StarRating
                      value={detail.ratingAvg ?? 0}
                      readonly
                      size="lg"
                    />
                    <span className="text-2xl font-bold text-fg-primary">
                      {(detail.ratingAvg ?? 0).toFixed(1)}
                    </span>
                    <span className="text-sm text-fg-muted">
                      sur 5 — {detail.ratingCount} avis
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted mt-3">
                    Pour écrire un avis détaillé, ouvre la page de la variante
                    téléchargeable correspondante (clique sur l'icône{' '}
                    <DownloadIcon className="inline w-3 h-3 -mt-0.5" /> à côté
                    d'une source).
                  </p>
                </Card>
              </section>
            )}
            {!hasSources && detail.ratingCount === 0 && user && (
              <Card padding="lg" className="mb-6 border-dashed">
                <p className="text-xs text-fg-muted">
                  Personne n'a encore noté ce jeu sur Nexus. Importe un
                  catalogue JSON pour pouvoir le télécharger et laisser un
                  avis.
                </p>
              </Card>
            )}
          </div>

          {/* ── RIGHT SIDEBAR — Steam meta side-panel ─────────────── */}
          <aside className="space-y-6">
            <SteamMetaSection steamAppId={appid} sidebarOnly />
            <HowLongToBeatSection title={detail.name} />
          </aside>
        </div>
      </div>

      {/* Full achievements modal — same UX as JsonGamePage's
          "Voir tous les succès" overlay. */}
      <Modal
        open={achievementsModalOpen}
        onClose={() => setAchievementsModalOpen(false)}
        title="Tous les succès"
        description={
          achievementsTotal
            ? `0 / ${achievementsTotal} débloqués — lance le jeu via Nexus pour progresser`
            : undefined
        }
        maxWidth="2xl"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {achievements.map((a) => (
            <SteamAchievementCard key={a.apiName} achievement={a} />
          ))}
        </div>
      </Modal>
    </div>
  )
}

/**
 * Achievement card — mirrors `AchievementCard` in JsonGamePage.tsx
 * exactly: same locked-state grayscale filter, same lock overlay,
 * same hidden-title teaser. Local copy because JsonGamePage's is
 * not exported; if we refactor later, both can use the shared
 * component.
 */
function SteamAchievementCard({
  achievement: a,
}: {
  achievement: {
    apiName: string
    displayName: string
    description: string | null
    iconUrl: string | null
    iconGrayUrl: string | null
    hidden: boolean
    unlockedAt: number | null
  }
}) {
  const unlocked = a.unlockedAt != null
  const iconColour = a.iconUrl ?? a.iconGrayUrl
  const [imgError, setImgError] = useState(false)
  const description =
    a.hidden && !unlocked
      ? 'Succès caché — débloque-le pour révéler.'
      : a.description
  return (
    <div
      className={`flex items-start gap-3 text-left p-3 rounded-md border w-full ${
        unlocked
          ? 'border-accent-primary/40 bg-accent-primary/5'
          : 'border-glass-border bg-[var(--surface-soft)]'
      }`}
    >
      <div className="w-12 h-12 rounded-md bg-bg-tertiary border border-glass-border overflow-hidden shrink-0 flex items-center justify-center relative">
        {iconColour && !imgError ? (
          <img
            src={iconColour}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover transition-all ${
              unlocked ? '' : 'grayscale brightness-50 contrast-110'
            }`}
          />
        ) : (
          <Trophy className="w-5 h-5 text-fg-muted" />
        )}
        {!unlocked && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Lock className="w-4 h-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-semibold truncate ${
            unlocked ? 'text-fg-primary' : 'text-fg-secondary'
          }`}
        >
          {a.displayName}
        </p>
        {description && (
          <p className="text-[11px] text-fg-muted leading-snug mt-0.5 line-clamp-2">
            {description}
          </p>
        )}
      </div>
    </div>
  )
}
