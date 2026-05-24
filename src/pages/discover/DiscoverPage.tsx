/**
 * Découvrir — page d'accueil refondue v0.4.
 *
 * Hero slideshow → catégories en capsules → liste active.
 * Glassmorphism partout, transitions Framer Motion sur le switch
 * de catégorie pour un rendu fluide.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Flame } from '@/lib/icons'
import { HeroSlideshow } from '@/components/discover/HeroSlideshow'
import { CategoryButtons } from '@/components/discover/CategoryButtons'
import { Steam250RowList } from '@/components/discover/Steam250RowList'
import { SteamChartsRowList } from '@/components/discover/SteamChartsRowList'

type CategoryKey = 'trending' | 'best' | 'top250'

export default function DiscoverPage() {
  const [active, setActive] = useState<CategoryKey>('trending')
  // The `monthLabel` state used to drive a "Top releases — {Month YYYY}"
  // heading powered by Steam's `GetTopReleasesPages`. We dropped that
  // endpoint because it's frozen on February 2025 (Steam hasn't shipped
  // a fresher page in 15+ months). The "best" category now reads
  // Steam-250's `/30day` list which is genuinely current — no dynamic
  // month label needed.

  const heading =
    active === 'trending'
      ? 'Tendance — Les plus joués cette semaine'
      : active === 'best'
        ? 'Meilleures sorties récentes — 30 derniers jours'
        : 'Top 250 de tous les temps'

  const subhead =
    active === 'trending'
      ? 'Ce sur quoi les joueurs passent le plus de temps en ce moment.'
      : active === 'best'
      ? 'Notes Steam des 30 derniers jours — les jeux que les joueurs adorent en ce moment.'
      : 'Le classement long-terme, indépendant des modes passagères.'

  return (
    <div className="px-6 lg:px-10 py-6 max-w-[1600px] mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <HeroSlideshow />
      </motion.div>

      <CategoryButtons active={active} onChange={setActive} />

      <AnimatePresence mode="wait">
        <motion.section
          key={active}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-end justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <span className="mt-1 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-accent-gradient-soft border border-accent-primary/30 text-accent-primary shrink-0">
                {active === 'trending' ? (
                  <Flame className="w-4 h-4" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
              </span>
              <div>
                <h2 className="text-xl font-bold text-fg-primary tracking-tight font-display">
                  {heading}
                </h2>
                <p className="text-xs text-fg-muted mt-0.5">{subhead}</p>
              </div>
            </div>
          </div>
          {active === 'trending' && (
            <SteamChartsRowList mode="most-played" limit={12} />
          )}
          {active === 'best' && (
            // Steam-250's `/30day` aggregates Steam-review scores
            // over a true 30-day rolling window, refreshed daily.
            // Replaces Steam's own `GetTopReleasesPages` which is
            // frozen on February 2025 (R.E.P.O. era).
            <Steam250RowList listId="last-30-days" limit={12} />
          )}
          {active === 'top250' && (
            // SteamSpy `top100owned` — ranked by lifetime sales, which
            // is what users mentally mean by "Top de tous les temps"
            // (GTA, Skyrim, Elden Ring, Terraria, …). Steam-250's own
            // `/top250` is review-score-based and surfaces indie hits
            // ahead of mainstream AAA — kept available via the
            // Catalogue page if a user wants that ranking.
            <SteamChartsRowList mode="top-owned" limit={12} />
          )}
        </motion.section>
      </AnimatePresence>
    </div>
  )
}
