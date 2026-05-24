import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, AlertCircle, Globe } from '@/lib/icons'
import { useAddonStore } from '@/stores/addon.store'
import { Card } from '@/components/ui/Card'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { GameHero } from '@/components/game/GameHero'
import { GameScreenshots } from '@/components/game/GameScreenshots'
import { DownloadSourcePicker } from '@/components/game/DownloadSourcePicker'
import { AddToLibraryButton } from '@/components/community/AddToLibraryButton'
import { ReviewsSection } from '@/components/community/ReviewsSection'
import type { GameDetail } from '@/types/addon.types'

export default function GamePage() {
  const { addonId, gameId } = useParams<{ addonId: string; gameId: string }>()
  const navigate = useNavigate()
  const addons = useAddonStore((s) => s.addons)
  const addon = addons.find((a) => a.id === addonId)

  const [game, setGame] = useState<GameDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!addonId || !gameId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setGame(null)
    void window.nexus.addons.meta(addonId, gameId).then((res) => {
      if (cancelled) return
      if (res.ok) setGame(res.data)
      else setError(res.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [addonId, gameId])

  if (!addonId || !gameId) return null

  if (loading) {
    return (
      <div className="py-20 flex items-center justify-center gap-2 text-sm text-fg-muted">
        <LoadingSpinner size="md" /> Chargement du jeu…
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-10 py-10 max-w-3xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg-primary transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Retour
        </button>
        <Card padding="lg" className="border-error/30 bg-error/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg-primary">Impossible de charger le jeu</p>
              <p className="text-sm text-fg-secondary mt-1 break-words">{error}</p>
              <p className="text-xs text-fg-muted mt-2 break-all">
                Addon&nbsp;: <span className="font-mono">{addon?.name ?? addonId}</span> · ID du jeu&nbsp;:{' '}
                <span className="font-mono">{gameId}</span>
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (!game) return null

  const externalGameId = `${addonId}:${gameId}`

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
      <div className="relative">
        <GameHero game={game} addonName={addon?.name ?? addonId} />
        <button
          onClick={() => navigate(-1)}
          className="absolute top-6 left-6 lg:left-10 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-white bg-black/40 backdrop-blur-sm border border-white/10 hover:bg-black/60 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Retour
        </button>
      </div>

      <div className="px-10 pb-10 pt-2 max-w-7xl mx-auto">
        <div className="flex justify-end mb-6">
          <AddToLibraryButton addonId={addonId} game={game} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10">
          <div className="lg:col-span-2">
            {game.description ? (
              <Card padding="lg">
                <h3 className="font-display font-bold text-lg text-fg-primary mb-3">À propos</h3>
                <p className="text-sm text-fg-secondary leading-relaxed whitespace-pre-wrap">{game.description}</p>
              </Card>
            ) : (
              <Card padding="lg">
                <p className="text-sm text-fg-muted italic">Aucune description fournie par l'addon.</p>
              </Card>
            )}
          </div>
          <aside className="flex flex-col gap-4">
            <Card padding="md">
              <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-3">Infos</h3>
              <dl className="flex flex-col gap-2 text-sm">
                {game.developer && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-fg-muted">Développeur</dt>
                    <dd className="text-fg-primary text-right">{game.developer}</dd>
                  </div>
                )}
                {game.publisher && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-fg-muted">Éditeur</dt>
                    <dd className="text-fg-primary text-right">{game.publisher}</dd>
                  </div>
                )}
                {game.releaseDate && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-fg-muted">Sortie</dt>
                    <dd className="text-fg-primary text-right">{game.releaseDate}</dd>
                  </div>
                )}
                {game.genres && game.genres.length > 0 && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-fg-muted">Genres</dt>
                    <dd className="text-fg-primary text-right">{game.genres.join(', ')}</dd>
                  </div>
                )}
              </dl>
            </Card>

            {addon?.manifest.homepage && (
              <a
                href={addon.manifest.homepage}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 text-xs text-fg-muted hover:text-accent-primary transition-colors"
              >
                <Globe className="w-3 h-3" /> Site de l'addon
              </a>
            )}
          </aside>
        </div>

        {game.systemRequirements && (game.systemRequirements.min || game.systemRequirements.recommended) && (
          <Card padding="lg" className="mb-10">
            <h3 className="font-display font-bold text-lg text-fg-primary mb-4">Configuration requise</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {game.systemRequirements.min && (
                <div>
                  <p className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-2">Minimale</p>
                  <dl className="flex flex-col gap-1 text-sm">
                    {Object.entries(game.systemRequirements.min).map(([k, v]) => (
                      <div key={k} className="flex items-start gap-3">
                        <dt className="text-fg-muted capitalize w-24 shrink-0">{k}</dt>
                        <dd className="text-fg-primary flex-1">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {game.systemRequirements.recommended && (
                <div>
                  <p className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-2">
                    Recommandée
                  </p>
                  <dl className="flex flex-col gap-1 text-sm">
                    {Object.entries(game.systemRequirements.recommended).map(([k, v]) => (
                      <div key={k} className="flex items-start gap-3">
                        <dt className="text-fg-muted capitalize w-24 shrink-0">{k}</dt>
                        <dd className="text-fg-primary flex-1">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          </Card>
        )}

        {game.screenshotUrls && game.screenshotUrls.length > 0 && (
          <div className="mb-10">
            <h3 className="font-display font-bold text-lg text-fg-primary mb-4">Captures d'écran</h3>
            <GameScreenshots urls={game.screenshotUrls} />
          </div>
        )}

        <div className="mb-10">
          <DownloadSourcePicker
            addonId={addonId}
            gameId={gameId}
            gameTitle={game.title}
            coverUrl={game.coverUrl}
          />
        </div>

        <div className="mb-10">
          <ReviewsSection externalGameId={externalGameId} />
        </div>
      </div>
    </motion.div>
  )
}
