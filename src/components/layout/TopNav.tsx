import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Search,
  Monitor,
  Settings,
  Palette,
  Puzzle,
  LogOut,
  User as UserIcon,
  ChevronDown,
  X,
  Shield,
  Dices,
  Compass,
  Library as LibraryIcon,
  Download,
  Users,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useDownloadStore } from '@/stores/download.store'
import { useSocialStore } from '@/stores/social.store'
import { Username } from '@/components/common/Username'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { CloudStatusBadge } from '@/components/cloud/CloudStatusBadge'
import { cn } from '@/utils/cn'

interface NavTab {
  to: string
  label: string
  icon: LucideIcon
  badge?: number
}

const NAV_TABS: ReadonlyArray<Omit<NavTab, 'badge'>> = [
  { to: '/discover', label: 'Découvrir', icon: Compass },
  { to: '/catalogue', label: 'Catalogue', icon: Sparkles },
  { to: '/library', label: 'Bibliothèque', icon: LibraryIcon },
  { to: '/downloads', label: 'Téléchargements', icon: Download },
  { to: '/community', label: 'Communauté', icon: Users },
]

/**
 * Top navigation refondue — glassmorphism, capsules arrondies, accent
 * violet. Tab strip avec icônes Lucide, search globale Ctrl+K, user
 * dropdown élégant. Plus de "Steam-flavored" — c'est du Nexus pur.
 */
export function TopNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  // Compte sans allouer un array — appelé sur chaque store update,
  // on évite filter(...).length qui crée un sous-array à jeter.
  const activeDownloads = useDownloadStore((s) => {
    let count = 0
    for (const d of s.downloads) {
      if (d.status === 'downloading' || d.status === 'queued') count++
    }
    return count
  })
  const friendCount = useSocialStore((s) => s.friends.length)

  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Re-décore les tabs statiques avec leur badge dynamique courant.
  const tabs: NavTab[] = NAV_TABS.map((t) =>
    t.to === '/downloads' ? { ...t, badge: activeDownloads }
    : t.to === '/community' ? { ...t, badge: friendCount }
    : { ...t }
  )

  // Ctrl+K focuses the search globally — listen at window level so any page works.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q')
    if (q !== null && q !== query) setQuery(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  useEffect(() => {
    if (!menuOpen) return
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  function submitSearch(v: string) {
    const trimmed = v.trim()
    navigate(trimmed ? `/catalogue?q=${encodeURIComponent(trimmed)}` : '/catalogue')
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitSearch(query)
    } else if (e.key === 'Escape') {
      setQuery('')
      inputRef.current?.blur()
    }
  }

  const inBigPicture = location.pathname.startsWith('/big-picture')

  return (
    <nav className="relative h-16 flex items-center gap-3 px-5 bg-bg-secondary/60 backdrop-blur-xl border-b border-glass-border shrink-0 select-none z-20">
      {/* Tab strip — capsule arrondie sur fond glass */}
      <ul className="flex items-center gap-1 p-1 rounded-full glass-card">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn(
                  'relative h-10 px-4 inline-flex items-center gap-2 rounded-full text-[13px] font-semibold transition-all duration-300 ease-out-expo',
                  isActive
                    ? 'bg-accent-gradient text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.6)]'
                    : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-soft'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <tab.icon
                    className={cn(
                      'w-4 h-4 transition-transform',
                      isActive && 'scale-110'
                    )}
                  />
                  <span className="hidden md:inline">{tab.label}</span>
                  {tab.badge != null && tab.badge > 0 && (
                    <span
                      className={cn(
                        'min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold flex items-center justify-center',
                        isActive
                          ? 'bg-white/25 text-white'
                          : 'bg-accent-primary/20 text-accent-primary'
                      )}
                    >
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {/* Search — pill flottante */}
      <div className="flex-1 max-w-xl mx-2">
        <div
          className={cn(
            'flex items-center gap-2.5 h-11 px-4 rounded-full transition-all duration-300',
            'glass-card hover:border-accent-primary/30',
            'focus-within:border-accent-primary/60 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.18)]'
          )}
        >
          <Search className="w-4 h-4 text-fg-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Rechercher un jeu, un genre, un développeur…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-faint"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              className="p-1 -m-1 rounded-full text-fg-muted hover:bg-surface-soft hover:text-fg-primary transition-colors"
              aria-label="Effacer la recherche"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="text-[10px] text-fg-muted font-mono px-2 py-1 rounded-md bg-surface-soft border border-glass-border">
              Ctrl K
            </kbd>
          )}
        </div>
      </div>

      {/* Quick actions cluster */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={async () => {
            const res = await window.nexus.jsonSources.pickRandom()
            if (res.ok) {
              navigate(`/json-game/${encodeURIComponent(res.game.id)}`)
            }
          }}
          title="Jeu aléatoire — surprend-moi"
          className="h-10 w-10 inline-flex items-center justify-center rounded-full text-fg-secondary hover:bg-surface-soft hover:text-accent-primary transition-all duration-200"
        >
          <Dices className="w-4 h-4" />
        </button>

        <button
          onClick={() => navigate(inBigPicture ? '/' : '/big-picture')}
          title={inBigPicture ? 'Quitter Big Picture' : 'Mode Big Picture'}
          className={cn(
            'h-10 w-10 inline-flex items-center justify-center rounded-full transition-all duration-200',
            inBigPicture
              ? 'bg-accent-gradient text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.5)]'
              : 'text-fg-secondary hover:bg-surface-soft hover:text-accent-primary'
          )}
        >
          <Monitor className="w-4 h-4" />
        </button>

        <CloudStatusBadge />
        <NotificationBell />
      </div>

      {/* User dropdown */}
      {user && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={cn(
              'h-11 pl-1 pr-3 flex items-center gap-2.5 rounded-full transition-all duration-200',
              menuOpen
                ? 'bg-surface-soft-hover border border-accent-primary/30'
                : 'border border-transparent hover:bg-surface-soft hover:border-glass-border'
            )}
          >
            <span className="relative w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0 shadow-[0_2px_8px_-2px_rgba(124,92,255,0.5)]">
              {user.avatarPath ? (
                <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xs font-bold text-white">
                  {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <Username
              user={user}
              className="hidden md:inline text-sm font-semibold text-fg-primary max-w-[140px] truncate"
            />
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 text-fg-muted transition-transform duration-200',
                menuOpen && 'rotate-180'
              )}
            />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] w-72 z-50 rounded-2xl glass-elevated overflow-hidden animate-slide-down">
              <Link
                to={`/community/profile/${user.id}`}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-4 bg-accent-gradient-soft hover:bg-surface-soft-hover transition-colors border-b border-glass-border"
              >
                <span className="relative w-12 h-12 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0 shadow-[0_4px_12px_-2px_rgba(124,92,255,0.5)]">
                  {user.avatarPath ? (
                    <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-base font-bold text-white">
                      {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <Username
                    user={user}
                    className="block text-sm font-bold text-fg-primary truncate"
                  />
                  <p className="text-[11px] text-fg-muted font-mono truncate">@{user.username}</p>
                </div>
              </Link>

              <div className="py-2">
                <MenuItem
                  icon={UserIcon}
                  label="Voir mon profil"
                  to={`/community/profile/${user.id}`}
                  onClick={() => setMenuOpen(false)}
                />
                <MenuItem
                  icon={Settings}
                  label="Paramètres"
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                />
                <MenuItem
                  icon={Shield}
                  label="Confidentialité"
                  to="/settings/privacy"
                  onClick={() => setMenuOpen(false)}
                />
                <MenuItem
                  icon={Palette}
                  label="Thèmes"
                  to="/themes"
                  onClick={() => setMenuOpen(false)}
                />
                <MenuItem
                  icon={Puzzle}
                  label="Addons"
                  to="/addons"
                  onClick={() => setMenuOpen(false)}
                />
              </div>

              <div className="border-t border-glass-border py-2">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void logout()
                  }}
                  className="w-full flex items-center gap-3 px-4 h-10 text-sm font-medium text-fg-secondary hover:bg-error-soft hover:text-error transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Déconnexion</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

function MenuItem({
  icon: Icon,
  label,
  to,
  onClick,
}: {
  icon: LucideIcon
  label: string
  to: string
  onClick: () => void
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="flex items-center gap-3 px-4 h-10 text-sm font-medium text-fg-secondary hover:bg-surface-soft-hover hover:text-fg-primary transition-colors"
    >
      <Icon className="w-4 h-4 text-fg-muted" />
      <span>{label}</span>
    </Link>
  )
}
