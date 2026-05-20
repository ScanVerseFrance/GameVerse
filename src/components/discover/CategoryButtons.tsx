/**
 * Découvrir — boutons de catégories refondus en capsules glass.
 *
 *   [🔥 Tendance]  [📅 Top sorties]  [🏆 Top 250]                    [✨ Surprenez-moi]
 *
 * Pills arrondies pleines au repos, gradient accent quand sélectionnées.
 */
import { useNavigate } from 'react-router-dom'
import { Flame, CalendarDays, Trophy, Sparkles } from 'lucide-react'
import { cn } from '@/utils/cn'

interface CategoryButtonsProps {
  active: 'trending' | 'best' | 'top250'
  onChange: (key: 'trending' | 'best' | 'top250') => void
}

export function CategoryButtons({ active, onChange }: CategoryButtonsProps) {
  const navigate = useNavigate()

  async function surpriseMe() {
    const res = await window.nexus.jsonSources.pickRandom()
    if (res.ok) {
      navigate(`/json-game/${encodeURIComponent(res.game.id)}`)
    } else {
      navigate('/catalogue')
    }
  }

  const items: Array<{
    key: 'trending' | 'best' | 'top250'
    label: string
    icon: typeof Flame
  }> = [
    { key: 'trending', label: 'Tendance', icon: Flame },
    { key: 'best', label: 'Top sorties du mois', icon: CalendarDays },
    { key: 'top250', label: 'Top 250 de tous les temps', icon: Trophy },
  ]

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap my-7">
      <div className="flex items-center gap-2 p-1.5 rounded-full glass-card">
        {items.map((it) => {
          const Icon = it.icon
          const isActive = it.key === active
          return (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              className={cn(
                'inline-flex items-center gap-2 px-4 h-10 rounded-full text-sm font-semibold transition-all duration-300 ease-out-expo',
                isActive
                  ? 'bg-accent-gradient text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.6)]'
                  : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-soft'
              )}
            >
              <Icon className={cn('w-4 h-4', isActive && 'scale-110')} />
              {it.label}
            </button>
          )
        })}
      </div>

      <button
        onClick={surpriseMe}
        className="inline-flex items-center gap-2 h-11 px-5 rounded-full border border-accent-primary/30 bg-accent-gradient-soft text-accent-primary hover:bg-accent-primary/15 hover:border-accent-primary/50 active:scale-[0.97] transition-all duration-200 text-sm font-semibold shadow-[0_2px_12px_-2px_rgba(124,92,255,0.4)]"
      >
        <Sparkles className="w-4 h-4" />
        Surprenez-moi
      </button>
    </div>
  )
}
