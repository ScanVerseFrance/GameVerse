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
  badge?: number
}

/**
 * Steam-flavored top navigation. Horizontal tab strip + integrated search
 * + Big Picture shortcut + user menu. Replaces the old left sidebar for
 * top-level navigation; the secondary surfaces (Settings, Themes, Addons)
 * are exposed via the user dropdown to keep the strip clean.
 */
export function TopNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const activeDownloads = useDownloadStore(
    (s) => s.downloads.filter((d) => d.status === 'downloading' || d.status === 'queued').length
  )
  const friendCount = useSocialStore((s) => s.friends.length)

  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const tabs: NavTab[] = [
    { to: '/', label: 'Accueil' },
    { to: '/library', label: 'Bibliothèque' },
    { to: '/discover', label: 'Découvrir' },
    { to: '/downloads', label: 'Téléchargements', badge: activeDownloads },
    { to: '/community', label: 'Communauté', badge: friendCount },
  ]

  // Ctrl+K focuses search globally — listen at window level so any page works.
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

  // Sync search box with URL when the user lands on /discover via another link.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q')
    if (q !== null && q !== query) setQuery(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  // Click-outside closes the user dropdown.
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
    navigate(trimmed ? `/discover?q=${encodeURIComponent(trimmed)}` : '/discover')
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
    <nav className="h-14 flex items-center gap-2 px-4 bg-bg-secondary border-b border-border-soft shrink-0 select-none">
      {/* Tab strip */}
      <ul className="flex items-stretch h-full">
        {tabs.map((tab) => (
          <li key={tab.to} className="h-full">
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn(
                  'relative h-full px-4 inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider transition-colors',
                  isActive
                    ? 'text-fg-primary'
                    : 'text-fg-muted hover:text-fg-secondary'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span>{tab.label}</span>
                  {tab.badge != null && tab.badge > 0 && (
                    <span
                      className={cn(
                        'min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold flex items-center justify-center',
                        isActive
                          ? 'bg-accent-primary text-white'
                          : 'bg-[var(--surface-medium)] text-fg-secondary'
                      )}
                    >
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </span>
                  )}
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute left-3 right-3 bottom-0 h-[3px] rounded-t bg-accent-gradient"
                    />
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {/* Search bar — flex-grows to fill the middle. */}
      <div className="flex-1 max-w-md mx-3">
        <div className="flex items-center gap-2 h-9 px-3 rounded-sm bg-[#0f1721] border border-[#0a0e15] focus-within:border-accent-primary/50 transition-colors">
          <Search className="w-3.5 h-3.5 text-fg-muted" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Rechercher dans Découvrir…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            className="flex-1 bg-transparent outline-none text-xs text-fg-primary placeholder:text-fg-muted"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              className="text-fg-muted hover:text-fg-primary"
              aria-label="Effacer la recherche"
            >
              <X className="w-3 h-3" />
            </button>
          ) : (
            <kbd className="text-[10px] text-fg-muted font-mono px-1.5 py-0.5 rounded-sm bg-black/30">
              Ctrl+K
            </kbd>
          )}
        </div>
      </div>

      {/* Big Picture shortcut */}
      <button
        onClick={() => navigate(inBigPicture ? '/' : '/big-picture')}
        title={inBigPicture ? 'Quitter Big Picture' : 'Mode Big Picture'}
        className={cn(
          'h-9 px-3 inline-flex items-center gap-1.5 rounded-sm text-[11px] font-bold uppercase tracking-widest transition-colors border',
          inBigPicture
            ? 'bg-accent-primary/15 text-accent-primary border-accent-primary/30'
            : 'border-transparent text-fg-secondary hover:bg-[var(--surface-soft)] hover:text-fg-primary'
        )}
      >
        <Monitor className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Big Picture</span>
      </button>

      {/* Nexus Cloud connection chip — green dot when authenticated +
          live, grey when not signed in, orange when the WebSocket
          dropped. Clicking opens login or a small popover. */}
      <CloudStatusBadge />

      {/* In-app notifications (bell + dropdown). Available whether or
          not the user is signed in — guest sessions still get download
          and library notifications. */}
      <NotificationBell />

      {/* User dropdown */}
      {user && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={cn(
              'h-9 pl-1 pr-2 flex items-center gap-2 rounded-sm border transition-colors',
              menuOpen
                ? 'bg-[var(--surface-soft-hover)] border-glass-border'
                : 'border-transparent hover:bg-[var(--surface-soft)]'
            )}
          >
            <span className="w-7 h-7 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
              {user.avatarPath ? (
                <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-[11px] font-bold text-white">
                  {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <Username
              user={user}
              className="hidden md:inline text-[13px] font-semibold text-fg-primary max-w-[140px] truncate"
            />
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 text-fg-muted transition-transform',
                menuOpen && 'rotate-180'
              )}
            />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] w-64 z-50 rounded-md bg-bg-secondary border border-glass-border shadow-lift overflow-hidden">
              {/* Header */}
              <Link
                to={`/community/profile/${user.id}`}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-3 bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] transition-colors"
              >
                <span className="w-10 h-10 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                  {user.avatarPath ? (
                    <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-sm font-bold text-white">
                      {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <Username
                    user={user}
                    className="block text-sm font-semibold text-fg-primary truncate"
                  />
                  <p className="text-[11px] text-fg-muted font-mono truncate">@{user.username}</p>
                </div>
              </Link>

              <div className="py-1">
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

              <div className="border-t border-border-soft py-1">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void logout()
                  }}
                  className="w-full flex items-center gap-2.5 px-4 h-9 text-sm text-fg-secondary hover:bg-[var(--surface-soft-hover)] hover:text-error transition-colors"
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
      className="flex items-center gap-2.5 px-4 h-9 text-sm text-fg-secondary hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary transition-colors"
    >
      <Icon className="w-4 h-4 text-fg-muted" />
      <span>{label}</span>
    </Link>
  )
}
