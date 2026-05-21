/**
 * ProfileAchievementsBoard — port of ScanVerse's AchievementsBoard.
 *
 * Renders the 15-entry catalogue defined in
 * `src/config/profileAchievements.ts` with per-entry progress and
 * lock state. Each badge tints by tier (bronze < silver < gold);
 * locked tiles show a small lock overlay on the icon + the
 * incremental progress bar at the bottom.
 *
 * Mounted by the Profile page's "Achievements" tab and called via
 * `window.nexus.profile.achievements(userId)`.
 */
import { useEffect, useState } from 'react'
import {
  Trophy,
  Lock,
  Users as UsersIcon,
  Target,
  Star,
  Library,
  PenLine,
  Edit3,
  BookOpen,
  Shield,
  CheckCircle2,
  Smile,
  Tag,
  Users,
  Moon,
  Flame,
  Zap,
  Activity,
  Gamepad2,
  type LucideIcon,
} from 'lucide-react'

interface ComputedAchievement {
  id: string
  name: string
  description: string
  iconName: string
  tier: 'bronze' | 'silver' | 'gold'
  target: number
  metric: string | null
  progress: number
  unlocked: boolean
  communityPct: number | null
}

const ICON_MAP: Record<string, LucideIcon> = {
  Target,
  Star,
  Library,
  PenLine,
  Edit3,
  BookOpen,
  Shield,
  CheckCircle2,
  Smile,
  Tag,
  Users,
  Moon,
  Flame,
  Zap,
  Activity,
  Gamepad2,
}

const TIER_COLORS: Record<
  ComputedAchievement['tier'],
  { bg: string; fg: string; border: string }
> = {
  bronze: { bg: 'rgba(205,127,50,0.15)', fg: '#cd7f32', border: 'rgba(205,127,50,0.4)' },
  silver: { bg: 'rgba(192,192,192,0.15)', fg: '#c0c0c0', border: 'rgba(192,192,192,0.4)' },
  gold: { bg: 'rgba(255,215,0,0.15)', fg: '#ffd700', border: 'rgba(255,215,0,0.4)' },
}

export function ProfileAchievementsBoard({ userId }: { userId: string }) {
  const [achievements, setAchievements] = useState<ComputedAchievement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.nexus.profile.achievements(userId).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) setAchievements(res.achievements)
      else setError(res.error ?? 'Impossible de charger les achievements')
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (loading) return <p className="text-sm text-fg-muted py-8 text-center">Chargement…</p>
  if (error) return <p className="text-sm text-error py-8 text-center">{error}</p>
  if (achievements.length === 0) return null

  const unlockedCount = achievements.filter((a) => a.unlocked).length
  const total = achievements.length

  return (
    <div
      className="rounded-2xl p-5"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h3
          className="font-semibold text-sm flex items-center gap-2"
          style={{ color: '#f0f0f5' }}
        >
          <Trophy size={14} style={{ color: '#ffd700' }} /> Achievements
        </h3>
        <div
          className="flex items-center gap-3 text-xs font-mono"
          style={{ color: '#9090a8' }}
        >
          <span>
            {unlockedCount}/{total} débloqués
          </span>
          <span className="flex items-center gap-1" style={{ color: '#7a7a92' }}>
            <UsersIcon size={11} /> Local
          </span>
        </div>
      </div>

      <div
        className="grid gap-2.5"
        style={{
          gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))',
        }}
      >
        {achievements.map((a) => (
          <AchievementBadge key={a.id} ach={a} />
        ))}
      </div>
    </div>
  )
}

function AchievementBadge({ ach: a }: { ach: ComputedAchievement }) {
  const tier = TIER_COLORS[a.tier] ?? TIER_COLORS.bronze
  const locked = !a.unlocked
  const Icon = ICON_MAP[a.iconName] ?? Trophy
  const progressPct =
    a.target > 0 ? Math.min(100, Math.round((a.progress / a.target) * 100)) : 0

  return (
    <div
      title={`${a.name} — ${a.description}`}
      className="rounded-xl p-3 relative flex flex-col"
      style={{
        background: locked ? 'rgba(255,255,255,0.025)' : tier.bg,
        border: `1px solid ${locked ? 'rgba(255,255,255,0.08)' : tier.border}`,
        transition: 'border 0.18s',
      }}
    >
      {/* Icon */}
      <div
        className="flex items-center justify-center mb-2 relative"
        style={{ height: 42 }}
      >
        <Icon
          size={30}
          strokeWidth={1.8}
          style={{ color: locked ? '#7a7a92' : tier.fg, opacity: locked ? 0.55 : 1 }}
        />
        {locked && (
          <span
            className="absolute"
            style={{ color: '#9090a8', bottom: -2, right: '38%' }}
          >
            <Lock size={12} />
          </span>
        )}
      </div>

      <p
        className="text-xs font-bold text-center mb-1"
        style={{ color: locked ? '#9090a8' : tier.fg }}
      >
        {a.name}
      </p>
      <p
        className="text-center leading-snug mb-2"
        style={{
          color: locked ? '#7a7a92' : '#cfcfdb',
          fontSize: 11,
        }}
      >
        {a.description}
      </p>

      {/* Progress bar — only for incremental locked achievements
          (`target > 1`). One-shot achievements (target = 1) jump
          straight from locked → unlocked, no in-between. */}
      {locked && a.target > 1 && (
        <div className="mt-auto">
          <div
            className="h-1.5 rounded-full overflow-hidden mb-1"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            <div
              className="h-full"
              style={{
                width: `${progressPct}%`,
                background: tier.fg,
                transition: 'width 0.4s ease',
                opacity: 0.65,
              }}
            />
          </div>
          <p
            className="text-center font-mono"
            style={{ color: '#9090a8', fontSize: 9 }}
          >
            {a.progress} / {a.target} {a.metric ?? ''}
          </p>
        </div>
      )}
    </div>
  )
}
