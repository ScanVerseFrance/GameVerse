import { Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Home,
  Compass,
  Download,
  Library,
  Users,
  Palette,
  Puzzle,
  Settings,
  ChevronLeft,
  LogOut,
  type LucideIcon,
} from 'lucide-react'
import { useSettingsStore } from '@/stores/settings.store'
import { useAuthStore } from '@/stores/auth.store'
import { useDownloadStore } from '@/stores/download.store'
import { Username } from '@/components/common/Username'
import { cn } from '@/utils/cn'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  badgeCount?: number
}

export function Sidebar() {
  const collapsed = useSettingsStore((s) => s.sidebarCollapsed)
  const toggle = useSettingsStore((s) => s.toggleSidebar)
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const downloads = useDownloadStore((s) => s.downloads)
  const location = useLocation()

  const activeDownloads = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued'
  ).length

  // Steam-style sidebar: section headers group items into logical buckets.
  // Each section renders its own block; the `collapsed` mode hides the labels
  // and the headers, keeping only the icons.
  interface NavSection {
    label: string
    items: NavItem[]
  }

  const sections: NavSection[] = [
    {
      label: 'Accueil',
      items: [
        { to: '/', label: 'Accueil', icon: Home },
        { to: '/discover', label: 'Découvrir', icon: Compass },
      ],
    },
    {
      label: 'Jeux',
      items: [
        { to: '/library', label: 'Bibliothèque', icon: Library },
        { to: '/downloads', label: 'Téléchargements', icon: Download, badgeCount: activeDownloads },
      ],
    },
    {
      label: 'Social',
      items: [{ to: '/community', label: 'Communauté', icon: Users }],
    },
    {
      label: 'Système',
      items: [
        { to: '/addons', label: 'Addons', icon: Puzzle },
        { to: '/themes', label: 'Thèmes', icon: Palette },
        { to: '/settings', label: 'Paramètres', icon: Settings },
      ],
    },
  ]

  return (
    <aside
      className={cn(
        'flex flex-col bg-bg-secondary border-r border-border-soft shrink-0 transition-[width] duration-300 ease-out',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3 px-2 flex flex-col gap-3">
        {sections.map((section, idx) => (
          <div key={section.label} className="flex flex-col gap-0.5">
            {!collapsed && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted px-3 mt-1 mb-1">
                {section.label}
              </p>
            )}
            {collapsed && idx > 0 && (
              <div className="mx-3 my-1 h-px bg-border-soft" aria-hidden />
            )}
            {section.items.map((item) => {
              const active =
                item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
              const Icon = item.icon

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'group relative flex items-center gap-3 h-9 px-3 rounded-sm transition-colors duration-150',
                    'text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]',
                    active && 'text-fg-primary bg-[var(--surface-soft-hover)]',
                    collapsed && 'justify-center px-0 h-10'
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="sidebar-indicator"
                      className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-accent-primary"
                      transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                    />
                  )}
                  <Icon className={cn('w-4 h-4 shrink-0', active && 'text-accent-primary')} />
                  {!collapsed && (
                    <span className="text-[13px] font-medium truncate flex-1">{item.label}</span>
                  )}
                  {item.badgeCount != null && item.badgeCount > 0 && (
                    <span
                      className={cn(
                        'shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-accent-primary text-white min-w-[18px] text-center',
                        collapsed && 'absolute top-0.5 right-0.5'
                      )}
                    >
                      {item.badgeCount > 99 ? '99+' : item.badgeCount}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border-soft p-3 flex flex-col gap-2">
        {user && (
          <div className={cn('flex items-center gap-3', collapsed && 'justify-center')}>
            <Link
              to={`/community/profile/${user.id}`}
              className="w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity"
              title="Voir ton profil"
            >
              {user.avatarPath ? (
                <img src={user.avatarPath} alt={user.username} className="w-full h-full object-cover" />
              ) : (
                <span className="text-sm font-bold text-white">
                  {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </Link>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <Username
                  user={user}
                  className="block text-sm font-medium text-fg-primary truncate"
                />
                <p className="text-xs text-fg-muted truncate">
                  {user.isGuest ? 'Mode invité' : `@${user.username}`}
                </p>
              </div>
            )}
            {!collapsed && (
              <button
                onClick={() => void logout()}
                title="Se déconnecter"
                className="p-2 rounded-sm text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-error transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        <button
          onClick={toggle}
          className={cn(
            'h-8 flex items-center justify-center rounded-sm text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary transition-all duration-200',
            collapsed && 'rotate-180'
          )}
          aria-label={collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
    </aside>
  )
}
