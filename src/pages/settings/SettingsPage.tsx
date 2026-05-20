import { useState, useEffect, useCallback, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  User as UserIcon,
  SlidersHorizontal,
  Palette,
  Download as DownloadIcon,
  Bell,
  Globe,
  HardDrive,
  Activity,
  Lock,
  Puzzle,
  Database,
  Image as ImageIcon,
  Trophy,
  Check,
  Trash2,
  Folder,
  ExternalLink,
  AlertCircle,
  LogOut,
  RefreshCw,
  KeyRound,
  AlertTriangle,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import { Slider } from '@/components/ui/Slider'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useAuthStore } from '@/stores/auth.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useDownloadStore } from '@/stores/download.store'
import { useAddonStore } from '@/stores/addon.store'
import type { AppSettings, SessionInfo, StorageUsage, SystemMetrics } from '@/types/app-settings.types'
import { cn } from '@/utils/cn'
import { ChangelogDialog } from '@/components/common/ChangelogDialog'
// Personnalisation tab content lives in its own file because it's
// ~500 lines of cosmetic grids (plaque / effect / decoration /
// music / username styling) ported wholesale from the ScanVerse
// settings layout. Keeping it out of this file holds the main
// router-level component readable.
import { PersonalisationSection } from './PersonalisationSection'

// 10 MB ceiling for avatar + banner uploads — same cap ComicScan uses.
// Stored as a data URL in SQLite (acceptable for 10 MB; SQLite has no
// practical row-size issue at this scale).
const AVATAR_MAX_BYTES = 10 * 1024 * 1024
const BANNER_MAX_BYTES = 10 * 1024 * 1024

const USERNAME_ANIMATIONS: Array<{ value: 'none' | 'shimmer' | 'rainbow' | 'pulse'; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'rainbow', label: 'Arc-en-ciel' },
  { value: 'pulse', label: 'Pulsation' },
]

const COLOR_SWATCHES = [
  '',          // reset
  '#8b5cf6',   // accent primary
  '#6366f1',   // accent secondary
  '#22c55e',   // success
  '#f59e0b',   // warning
  '#ef4444',   // error
  '#ec4899',   // pink
  '#06b6d4',   // cyan
  '#eab308',   // gold
  '#a78bfa',   // light violet
]
const TAB_ITEMS = [
  { value: 'account',       label: 'Compte',         icon: <UserIcon className="w-4 h-4" /> },
  { value: 'general',       label: 'Général',        icon: <SlidersHorizontal className="w-4 h-4" /> },
  // "Apparence" → "Personnalisation" : the tab now covers BOTH the
  // pure-visual options (themes, animations, blur) AND the profile
  // cosmetics that used to be hidden behind a community-page button
  // (plaques, effects, avatar decorations, profile music). Mirrors
  // the ScanVerse Settings layout where "Personnalisation" is the
  // catch-all visual tab.
  { value: 'personalisation', label: 'Personnalisation', icon: <Palette className="w-4 h-4" /> },
  { value: 'downloads',     label: 'Téléchargements',icon: <DownloadIcon className="w-4 h-4" /> },
  { value: 'notifications', label: 'Notifications',  icon: <Bell className="w-4 h-4" /> },
  { value: 'network',       label: 'Réseau',         icon: <Globe className="w-4 h-4" /> },
  { value: 'storage',       label: 'Stockage',       icon: <HardDrive className="w-4 h-4" /> },
  { value: 'performance',   label: 'Performance',    icon: <Activity className="w-4 h-4" /> },
  { value: 'security',      label: 'Sécurité',       icon: <Lock className="w-4 h-4" /> },
  { value: 'addons',        label: 'Addons',         icon: <Puzzle className="w-4 h-4" /> },
  { value: 'data',          label: 'Données',        icon: <Database className="w-4 h-4" /> },
]

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function SectionHeader({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description?: string }) {
  return (
    <div className="mb-6 pb-4 border-b border-border-soft">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-accent-primary" />
        <h2 className="text-base font-semibold text-fg-primary">{title}</h2>
      </div>
      {description && <p className="text-sm text-fg-secondary">{description}</p>}
    </div>
  )
}

// ───────── Account ─────────
function AccountSection() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const logout = useAuthStore((s) => s.logout)

  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [usernameColor, setUsernameColor] = useState(user?.usernameColor ?? '')
  const [usernameAnimation, setUsernameAnimation] = useState<
    'none' | 'shimmer' | 'rainbow' | 'pulse' | 'glitch' | 'neon'
  >(user?.usernameAnimation ?? 'none')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Sync local state with store when user data changes (login, reload).
  useEffect(() => {
    setDisplayName(user?.displayName ?? '')
    setBio(user?.bio ?? '')
    setEmail(user?.email ?? '')
    setUsernameColor(user?.usernameColor ?? '')
    setUsernameAnimation(user?.usernameAnimation ?? 'none')
  }, [user?.id])

  if (!user) return null

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    const ok = await updateProfile({
      displayName,
      bio,
      email: email || '',
      usernameColor,
      usernameAnimation,
    })
    setSaving(false)
    if (ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  // Avatar + banner share the same upload pipeline — both 10 MB max, both
  // stored as data URLs in the user row. Banner uses a much wider aspect
  // ratio so its size on disk grows faster; the 10 MB cap is still generous.
  async function readAsDataUrl(f: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(f)
    })
  }

  async function handleAvatar(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > AVATAR_MAX_BYTES) {
      setUploadError(`Avatar trop volumineux (max ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} Mo).`)
      return
    }
    setUploadError(null)
    const url = await readAsDataUrl(f)
    if (url) await updateProfile({ avatarPath: url })
  }

  async function handleBanner(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > BANNER_MAX_BYTES) {
      setUploadError(`Bannière trop volumineuse (max ${Math.round(BANNER_MAX_BYTES / 1024 / 1024)} Mo).`)
      return
    }
    setUploadError(null)
    const url = await readAsDataUrl(f)
    if (url) await updateProfile({ bannerPath: url })
  }

  // Live preview of how the username will look — applies the same CSS the
  // rest of the app reads from when rendering the user's display name.
  const usernamePreviewStyle: React.CSSProperties = {
    color: usernameColor || undefined,
  }
  const usernameAnimationClass =
    usernameAnimation === 'shimmer'
      ? 'username-shimmer'
      : usernameAnimation === 'rainbow'
      ? 'username-rainbow'
      : usernameAnimation === 'pulse'
      ? 'username-pulse'
      : ''

  return (
    <div>
      <SectionHeader icon={UserIcon} title="Compte" description="Ton profil et la façon dont les autres te voient" />

      {/* Banner — full width, behind/above the avatar like Discord / Steam */}
      <div className="relative rounded-lg overflow-hidden border border-glass-border mb-4 group">
        <div
          className="h-32 w-full"
          style={
            user.bannerPath
              ? {
                  backgroundImage: `url(${user.bannerPath})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }
              : {
                  background:
                    'linear-gradient(135deg, rgba(136, 192, 87, 0.35), rgba(91, 163, 43, 0.25), rgba(102, 192, 244, 0.18))',
                }
          }
        />
        <div className="absolute inset-0 flex items-end justify-end p-3 gap-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
          <label className="cursor-pointer">
            <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-black/60 text-white text-xs font-medium hover:bg-black/80 transition-colors">
              <ImageIcon className="w-3.5 h-3.5" /> Changer la bannière
            </span>
            <input type="file" accept="image/*,image/gif" className="hidden" onChange={handleBanner} />
          </label>
          {user.bannerPath && (
            <button
              onClick={() => void updateProfile({ bannerPath: '' })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-black/60 text-white text-xs font-medium hover:bg-error/80 transition-colors"
            >
              Retirer
            </button>
          )}
        </div>
      </div>

      <div className="flex items-start gap-6 mb-6 flex-wrap md:flex-nowrap">
        <div className="flex flex-col items-center gap-2 -mt-12 z-10">
          <div className="w-24 h-24 rounded-full bg-bg-tertiary border-4 border-bg-primary overflow-hidden flex items-center justify-center shadow-lift">
            {user.avatarPath ? (
              <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="w-8 h-8 text-fg-muted" />
            )}
          </div>
          <div className="flex gap-1">
            <label className="cursor-pointer">
              <span className="text-xs text-accent-primary hover:underline">Importer</span>
              <input type="file" accept="image/*,image/gif" className="hidden" onChange={handleAvatar} />
            </label>
            {user.avatarPath && (
              <>
                <span className="text-xs text-fg-muted">·</span>
                <button
                  onClick={() => void updateProfile({ avatarPath: '' })}
                  className="text-xs text-fg-muted hover:text-error transition-colors"
                >
                  Retirer
                </button>
              </>
            )}
          </div>
          <p className="text-[10px] text-fg-muted text-center">JPG, PNG, GIF · 10 Mo max</p>
        </div>
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          <Input label="Nom affiché" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <Input label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              maxLength={300}
              className="bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] hover:border-[var(--surface-soft-border)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none focus:shadow-[0_0_0_3px_rgba(136,192,87,0.20)] rounded-md px-3.5 py-3 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
              placeholder="Parle un peu de toi aux autres joueurs…"
            />
            <span className="text-xs text-fg-muted self-end">{bio.length}/300</span>
          </div>
        </div>
      </div>

      {/* Username customisation — color swatches + animation picker.
          Lightweight version of ComicScan's full system (fonts/effects/etc).
          The preview line mirrors the styles we apply elsewhere. */}
      <div className="mt-6 pt-6 border-t border-border-soft">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary mb-3">
          Personnalisation du pseudo
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
              Couleur
            </label>
            <div className="flex flex-wrap gap-2">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c || 'reset'}
                  onClick={() => setUsernameColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${
                    (usernameColor || '') === c
                      ? 'border-fg-primary scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{
                    background:
                      c ||
                      'repeating-conic-gradient(rgba(255,255,255,0.15) 0% 25%, transparent 0% 50%) 50% / 6px 6px',
                  }}
                  title={c || 'Couleur par défaut'}
                  aria-label={c || 'Réinitialiser'}
                />
              ))}
            </div>
            <input
              type="text"
              value={usernameColor}
              onChange={(e) => setUsernameColor(e.target.value)}
              placeholder="#abc, rgb(…) ou vide"
              className="h-10 px-3 rounded-md bg-[var(--surface-soft)] border border-glass-border focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm font-mono text-fg-primary placeholder:text-fg-muted mt-1"
              maxLength={32}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
              Animation
            </label>
            <div className="grid grid-cols-2 gap-2">
              {USERNAME_ANIMATIONS.map((a) => (
                <button
                  key={a.value}
                  onClick={() => setUsernameAnimation(a.value)}
                  className={`h-10 rounded-md text-xs font-medium border transition-colors ${
                    usernameAnimation === a.value
                      ? 'border-accent-primary/60 bg-accent-primary/10 text-fg-primary'
                      : 'border-glass-border text-fg-secondary hover:bg-[var(--surface-soft)]'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="mt-4 p-4 rounded-md bg-[var(--surface-soft)] border border-glass-border">
          <p className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Aperçu</p>
          <span
            className={`font-display font-bold text-2xl ${usernameAnimationClass}`}
            style={usernamePreviewStyle}
          >
            {displayName || user.username}
          </span>
        </div>
      </div>

      {uploadError && (
        <div className="mt-4 flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{uploadError}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-6 mt-6 border-t border-border-soft flex-wrap gap-2">
        <div className="text-xs text-fg-muted">
          <span className="font-mono text-fg-secondary">@{user.username}</span> ·{' '}
          {user.isGuest ? 'Invité' : 'Compte complet'}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" leftIcon={<LogOut className="w-4 h-4" />} onClick={() => void logout()}>
            Déconnexion
          </Button>
          <Button onClick={handleSave} loading={saving} leftIcon={saved ? <Check className="w-4 h-4" /> : undefined}>
            {saved ? 'Enregistré' : 'Enregistrer'}
          </Button>
        </div>
      </div>

      {/* ─── Sécurité du compte ─── */}
      <AccountSecurityBlock />
    </div>
  )
}

/**
 * Account-security card stack: password change + irreversible
 * delete. Surfaced inside AccountSection per user spec ("dans
 * l'onglet compte met un bouton pour changer de mdp, supprimé son
 * compte"). Each block lives in its own Card so the destructive
 * delete action visually separates from the routine password change.
 */
function AccountSecurityBlock() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!user) return null
  return (
    <>
      <div className="mt-8 flex flex-col gap-4">
        <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest pl-1">
          Sécurité du compte
        </h3>

        {/* Password change */}
        <Card padding="md">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-10 h-10 rounded-md bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center shrink-0">
                <KeyRound className="w-4 h-4 text-accent-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg-primary">Mot de passe</p>
                <p className="text-xs text-fg-muted mt-0.5">
                  Reçois un code à usage unique par email puis définis un nouveau mot de
                  passe. Toutes tes autres sessions seront déconnectées.
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={() => setPasswordOpen(true)}>
              Modifier
            </Button>
          </div>
        </Card>

        {/* Account deletion — visually distinct rose tint to discourage
            accidental clicks. Hides behind a 2-step confirm dialog. */}
        <Card padding="md" className="border-error/30 bg-error/[0.03]">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-10 h-10 rounded-md bg-error/10 border border-error/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-error" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-error">Supprimer mon compte</p>
                <p className="text-xs text-fg-muted mt-0.5">
                  Action irréversible. Ton profil cloud, tes amis, tes succès et tes
                  sauvegardes seront perdus. Ta bibliothèque locale reste sur ton disque.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="border-error/40 text-error hover:bg-error/10"
              onClick={() => setDeleteOpen(true)}
            >
              Supprimer
            </Button>
          </div>
        </Card>
      </div>

      {passwordOpen && (
        <ChangePasswordDialog
          identifier={user.username}
          email={user.email ?? ''}
          onClose={() => setPasswordOpen(false)}
        />
      )}
      {deleteOpen && (
        <DeleteAccountDialog
          username={user.username}
          onCancel={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false)
            void logout()
          }}
        />
      )}
    </>
  )
}

/**
 * Password change flow. Two screens inside the same modal:
 *   1. "Send code" — user requests a recovery code, we email it.
 *   2. "Enter code + new password" — user pastes the code, types
 *      their new password, we POST consumeRecoveryCode.
 *
 * The actual transport is already wired in main:
 *   `auth:requestRecoveryCode` → returns { ok, code? } (dev returns
 *      the code inline; prod sends email only)
 *   `auth:consumeRecoveryCode` → returns { ok, error? }
 *
 * Both calls work for cloud-mirrored accounts because the launcher
 * creates a local row at adopt-time, and recovery looks up by email
 * OR username on the local store.
 */
function ChangePasswordDialog({
  identifier,
  email,
  onClose,
}: {
  identifier: string
  email: string
  onClose: () => void
}) {
  const [step, setStep] = useState<'request' | 'consume' | 'done'>('request')
  const [code, setCode] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devCode, setDevCode] = useState<string | null>(null)

  async function requestCode(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.nexus.auth.requestRecoveryCode(identifier)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Échec de l\'envoi du code')
      return
    }
    // In dev / local mode the IPC returns the code so we can show it
    // inline (the real app sends it by email in production).
    if (res.code) setDevCode(res.code)
    setStep('consume')
  }

  async function consumeCode(): Promise<void> {
    if (pw1.length < 8) {
      setError('Le mot de passe doit faire au moins 8 caractères.')
      return
    }
    if (pw1 !== pw2) {
      setError('Les deux mots de passe ne correspondent pas.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await window.nexus.auth.consumeRecoveryCode(code.trim(), pw1)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Code invalide ou expiré')
      return
    }
    setStep('done')
  }

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[#0f1320]/95 border border-white/10 shadow-2xl shadow-black/50 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/5">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-accent-primary" />
            Changer le mot de passe
          </h2>
        </div>
        <div className="p-5 space-y-4">
          {step === 'request' && (
            <>
              <p className="text-sm text-fg-secondary">
                Un code à usage unique va être envoyé à <span className="font-mono text-fg-primary">{email}</span>.
                Saisis-le à l'étape suivante pour définir un nouveau mot de passe.
              </p>
              {error && (
                <p className="text-xs text-error bg-error/10 border border-error/20 px-3 py-2 rounded-md">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={onClose}>Annuler</Button>
                <Button onClick={() => void requestCode()} loading={busy}>
                  Envoyer le code
                </Button>
              </div>
            </>
          )}

          {step === 'consume' && (
            <>
              {devCode && (
                <p className="text-xs bg-accent-primary/10 border border-accent-primary/30 px-3 py-2 rounded-md text-fg-secondary">
                  Mode dev : code généré = <span className="font-mono font-bold text-accent-primary">{devCode}</span>
                </p>
              )}
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
                  Code de récupération
                </label>
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-1234" />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
                  Nouveau mot de passe
                </label>
                <Input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder="8 caractères min." />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
                  Confirmer
                </label>
                <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="re-tape" />
              </div>
              {error && (
                <p className="text-xs text-error bg-error/10 border border-error/20 px-3 py-2 rounded-md">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={onClose}>Annuler</Button>
                <Button onClick={() => void consumeCode()} loading={busy}>
                  Mettre à jour
                </Button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <p className="text-sm text-success">
                Mot de passe modifié. Tu peux fermer cette fenêtre.
              </p>
              <div className="flex justify-end pt-2">
                <Button onClick={onClose}>OK</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Two-step destructive confirmation for account deletion. We require
 * the user to retype their username to enable the final button so an
 * accidental Enter-key doesn't wipe the account. The actual
 * delete-endpoint isn't wired yet — the button shows a "Bientôt"
 * notice and surfaces a request for the user to email support in the
 * interim. When the backend ships, swap the no-op for an IPC call.
 */
function DeleteAccountDialog({
  username,
  onCancel,
  onDeleted,
}: {
  username: string
  onCancel: () => void
  onDeleted: () => void
}) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canDelete = confirm.trim().toLowerCase() === username.toLowerCase()

  async function handleDelete(): Promise<void> {
    if (!canDelete) return
    setBusy(true)
    setError(null)
    // No `cloud:deleteAccount` IPC ships yet — the backend endpoint
    // is on the to-do list (see project_gameverse_backend.md). For
    // now we show a clear placeholder; flip this branch to the real
    // IPC the moment it lands.
    await new Promise((r) => setTimeout(r, 400))
    setBusy(false)
    setError(
      "La suppression définitive n'est pas encore branchée côté serveur. " +
        "Envoie un mail à support@scanverse.online en attendant — on s'en occupe à la main.",
    )
    return
    // eslint-disable-next-line no-unreachable
    onDeleted()
  }

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[#0f1320]/95 border border-error/30 shadow-2xl shadow-black/50 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-error/20 bg-error/5">
          <h2 className="text-lg font-bold text-error flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            Supprimer mon compte
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-fg-secondary">
            Cette action est <span className="text-error font-semibold">irréversible</span>.
            Ton profil cloud, tes amis, tes succès, tes sauvegardes et ton historique de
            chat seront supprimés. Ta bibliothèque locale et les fichiers de jeu sur ton
            disque restent intacts.
          </p>
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5 text-fg-muted">
              Pour confirmer, retape ton pseudo : <span className="text-fg-primary">{username}</span>
            </label>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={username} />
          </div>
          {error && (
            <p className="text-xs text-warning bg-warning/10 border border-warning/20 px-3 py-2 rounded-md">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onCancel}>Annuler</Button>
            <Button
              onClick={() => void handleDelete()}
              loading={busy}
              disabled={!canDelete}
              className="bg-error text-white hover:bg-error/80"
            >
              Supprimer définitivement
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────── General ─────────
function GeneralSection() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const downloadSettings = useDownloadStore((s) => s.settings)
  const updateDownload = useDownloadStore((s) => s.updateSettings)
  const pickFolder = useDownloadStore((s) => s.pickFolder)

  useEffect(() => {
    void window.nexus.appSettings.get().then((res) => {
      if (res.ok && res.settings) setAppSettings(res.settings)
    })
  }, [])

  async function update(patch: Partial<AppSettings>) {
    const res = await window.nexus.appSettings.update(patch)
    if (res.ok && res.settings) setAppSettings(res.settings)
  }

  return (
    <div>
      <SectionHeader icon={SlidersHorizontal} title="Général" description="Comportement de lancement et dossiers par défaut" />
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-fg-primary">Démarrer avec Windows</p>
            <p className="text-xs text-fg-muted mt-0.5">Lance Nexus automatiquement à l'ouverture de session</p>
          </div>
          {appSettings && (
            <Toggle checked={appSettings.autoLaunch} onChange={(v) => void update({ autoLaunch: v })} />
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border-soft pt-5">
          <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Dossier d'installation par défaut</label>
          <p className="text-xs text-fg-muted mb-1">Où les téléchargements atterrissent</p>
          <div className="flex gap-2">
            <div className="flex-1 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center text-sm font-mono text-fg-secondary truncate" title={downloadSettings?.defaultTargetFolder ?? ''}>
              {downloadSettings?.defaultTargetFolder ?? <span className="text-fg-muted italic">Non défini</span>}
            </div>
            <Button variant="outline" leftIcon={<Folder className="w-4 h-4" />} onClick={async () => {
              const p = await pickFolder()
              if (p) await updateDownload({ defaultTargetFolder: p })
            }}>
              Choisir
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ───────── Downloads ─────────
function DownloadsSection() {
  const settings = useDownloadStore((s) => s.settings)
  const update = useDownloadStore((s) => s.updateSettings)
  const pickFolder = useDownloadStore((s) => s.pickFolder)

  if (!settings) return <div className="text-sm text-fg-muted py-6 text-center">Chargement…</div>

  return (
    <div>
      <SectionHeader icon={DownloadIcon} title="Téléchargements" description="File d'attente et bande passante" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Slider
          label="Téléchargements simultanés max"
          value={settings.maxConcurrent}
          onChange={(v) => void update({ maxConcurrent: v })}
          min={1}
          max={10}
          step={1}
        />
        <Slider
          label="Limite de bande passante (torrent)"
          value={Math.round(settings.bandwidthLimitBps / 1024)}
          onChange={(v) => void update({ bandwidthLimitBps: v * 1024 })}
          min={0}
          max={50_000}
          step={100}
          formatValue={(v) => (v === 0 ? 'Illimitée' : `${formatBytes(v * 1024)}/s`)}
        />
        <Slider
          label="Ratio de seed cible"
          value={Math.round(settings.seedRatio * 10) / 10}
          onChange={(v) => void update({ seedRatio: v })}
          min={0}
          max={10}
          step={0.1}
          formatValue={(v) => v.toFixed(1)}
        />
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Dossier par défaut</label>
          <div className="flex gap-2">
            <div className="flex-1 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center text-xs font-mono text-fg-secondary truncate" title={settings.defaultTargetFolder}>
              {settings.defaultTargetFolder}
            </div>
            <Button variant="outline" leftIcon={<Folder className="w-4 h-4" />} onClick={async () => {
              const p = await pickFolder()
              if (p) await update({ defaultTargetFolder: p })
            }}>
              Choisir
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────── Notifications ─────────
function NotificationsSection() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const downloadSettings = useDownloadStore((s) => s.settings)
  const updateDownload = useDownloadStore((s) => s.updateSettings)

  useEffect(() => {
    void window.nexus.appSettings.get().then((res) => {
      if (res.ok && res.settings) setAppSettings(res.settings)
    })
  }, [])

  async function updateApp(patch: Partial<AppSettings>) {
    const res = await window.nexus.appSettings.update(patch)
    if (res.ok && res.settings) setAppSettings(res.settings)
  }

  const downloadNotif = downloadSettings?.notificationsEnabled ?? true
  const downloadCompleteFlag = appSettings?.notifications.downloadComplete ?? true
  const achievementFlag = appSettings?.notifications.achievementUnlocked ?? true
  const updateFlag = appSettings?.notifications.updateAvailable ?? true
  const friendMsgFlag = appSettings?.notifications.friendMessage ?? true
  const friendGameFlag = appSettings?.notifications.friendLaunchedGame ?? true
  const friendReqFlag = appSettings?.notifications.friendRequest ?? true

  // Diagnostic toast — pops a synthetic Windows toast and surfaces
  // whether Electron's Notification API thinks the OS supports it.
  // Catches "I disabled toasts in Windows Settings" and "Focus Assist
  // is on" without us having to dig through OS logs.
  const [testResult, setTestResult] = useState<null | { shown: boolean }>(null)
  const [testing, setTesting] = useState(false)
  async function runTest(): Promise<void> {
    setTesting(true)
    // v0.2.8: the test now pops a Steam-style in-app toast in the
    // floating overlay window (toast-window.service). We don't need
    // the OS-level diagnostic anymore — if the toast appears in the
    // bottom-right of the screen, it works. If it doesn't, the user
    // has bigger issues (renderer crashed, IPC broken, etc.) and the
    // DevTools console will say so.
    const r = await window.nexus.toast.test()
    setTestResult({ shown: r.ok })
    setTesting(false)
  }

  return (
    <div>
      <SectionHeader icon={Bell} title="Notifications" description="Toasts Steam-style affichés par Nexus" />
      <div className="flex flex-col gap-5">
        {/* Diagnostic test toast */}
        <div className="p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <p className="text-sm font-medium text-fg-primary">Tester une notification</p>
              <p className="text-xs text-fg-muted mt-0.5">
                Affiche un toast Steam-style dans le coin bas-droit de l'écran,
                indépendamment de l'état du launcher (minimisé, plein écran…).
              </p>
            </div>
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="h-8 px-3 rounded-md bg-accent-gradient text-white text-xs font-bold shrink-0 disabled:opacity-50"
            >
              {testing ? 'Test…' : 'Tester'}
            </button>
          </div>
          {testResult && (
            <p className={testResult.shown ? 'text-success text-xs' : 'text-error text-xs'}>
              {testResult.shown
                ? '✓ Toast envoyé — il devrait apparaître en bas à droite.'
                : '✗ Échec — vérifie la console DevTools (Ctrl+Shift+I).'}
            </p>
          )}
        </div>

        {/* Toggles */}
        <ToggleRow
          label="Téléchargement terminé"
          desc="Toast à la fin d'un téléchargement"
          checked={downloadCompleteFlag && downloadNotif}
          onChange={async (v) => {
            await updateApp({ notifications: { downloadComplete: v } })
            await updateDownload({ notificationsEnabled: v })
          }}
        />
        <ToggleRow
          label="Succès débloqué"
          desc="Toast quand un achievement de jeu est débloqué"
          checked={achievementFlag}
          onChange={(v) => updateApp({ notifications: { achievementUnlocked: v } })}
        />
        <ToggleRow
          label="Message d'un ami"
          desc="Toast Steam-style quand un ami t'écrit"
          checked={friendMsgFlag}
          onChange={(v) => updateApp({ notifications: { friendMessage: v } })}
        />
        <ToggleRow
          label="Un ami lance un jeu"
          desc="Toast quand un ami commence à jouer"
          checked={friendGameFlag}
          onChange={(v) => updateApp({ notifications: { friendLaunchedGame: v } })}
        />
        <ToggleRow
          label="Demande d'ami"
          desc="Toast quand quelqu'un t'envoie une friend request"
          checked={friendReqFlag}
          onChange={(v) => updateApp({ notifications: { friendRequest: v } })}
        />
        <ToggleRow
          label="Mise à jour disponible"
          desc="Toast quand le launcher détecte une nouvelle version"
          checked={updateFlag}
          onChange={(v) => updateApp({ notifications: { updateAvailable: v } })}
        />

        {/* Snooze — pause-all for a chosen window. Update-available
            toasts are still surfaced so security patches aren't
            missed. */}
        <SnoozeRow
          snoozeUntil={appSettings?.notifications.snoozeUntil ?? null}
          onSnooze={(minutes) =>
            updateApp({
              notifications: {
                snoozeUntil: minutes > 0 ? Date.now() + minutes * 60 * 1000 : null,
              },
            })
          }
        />

        {/* Diagnostic dump — tails the main-process debug log and
            lets the user open the .log file. Critical when chasing
            "test toast works, friend toast doesn't" regressions. */}
        <DiagnosticRow />
      </div>
    </div>
  )
}

function SnoozeRow({
  snoozeUntil,
  onSnooze,
}: {
  snoozeUntil: number | null
  onSnooze: (minutes: number) => Promise<void> | void
}) {
  const active = snoozeUntil != null && snoozeUntil > Date.now()
  // Re-render once a second while a snooze is active so the
  // countdown stays accurate without a full settings re-fetch.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [active])
  const remaining = active && snoozeUntil ? Math.max(0, snoozeUntil - Date.now()) : 0
  const hrs = Math.floor(remaining / 3600_000)
  const mins = Math.floor((remaining % 3600_000) / 60_000)
  const label = active
    ? `Silence actif · ${hrs > 0 ? `${hrs}h ` : ''}${mins.toString().padStart(2, '0')}min`
    : 'Aucun silence actif'
  return (
    <div className="p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="text-sm font-medium text-fg-primary">Mode silence</p>
          <p className="text-xs text-fg-muted mt-0.5">
            Mute tous les toasts (sauf MAJ critiques) pendant la durée choisie.
          </p>
          <p
            className={cn(
              'text-xs mt-1 font-mono',
              active ? 'text-accent-primary' : 'text-fg-muted',
            )}
          >
            {label}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {[15, 60, 240].map((m) => (
          <button
            key={m}
            onClick={() => void onSnooze(m)}
            className="h-7 px-3 rounded-md bg-[var(--surface-soft-hover)] hover:bg-accent-primary/20 hover:text-accent-primary text-xs font-medium border border-glass-border transition-colors"
          >
            {m < 60 ? `${m} min` : `${m / 60}h`}
          </button>
        ))}
        <button
          onClick={() => void onSnooze(0)}
          disabled={!active}
          className="h-7 px-3 rounded-md bg-[var(--surface-soft-hover)] hover:bg-error/20 hover:text-error text-xs font-medium border border-glass-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Réactiver
        </button>
      </div>
    </div>
  )
}

function DiagnosticRow() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  async function fetchTail(): Promise<void> {
    setLoading(true)
    try {
      const tail = await window.nexus.debug.tail(150)
      setLines(tail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="text-sm font-medium text-fg-primary">Journal diagnostique</p>
          <p className="text-xs text-fg-muted mt-0.5">
            Trace en direct du pipeline toasts + WebSocket. Utile pour
            comprendre pourquoi une notif n'apparaît pas.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => {
              void fetchTail().then(() => setExpanded(true))
            }}
            disabled={loading}
            className="h-7 px-3 rounded-md bg-[var(--surface-soft-hover)] hover:bg-accent-primary/20 hover:text-accent-primary text-xs font-medium border border-glass-border transition-colors disabled:opacity-50"
          >
            {loading ? '…' : expanded ? 'Rafraîchir' : 'Afficher'}
          </button>
          <button
            onClick={() => void window.nexus.debug.openLogFile()}
            className="h-7 px-3 rounded-md bg-[var(--surface-soft-hover)] hover:bg-accent-primary/20 hover:text-accent-primary text-xs font-medium border border-glass-border transition-colors"
          >
            Fichier
          </button>
        </div>
      </div>
      {expanded && lines.length > 0 && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-black/40 p-2 text-[10px] font-mono leading-relaxed text-fg-muted whitespace-pre-wrap">
          {lines.join('\n')}
        </pre>
      )}
      {expanded && lines.length === 0 && (
        <p className="text-xs text-fg-muted italic mt-2">
          Journal vide — boote le launcher et essaie de recevoir un message
          pour générer des entrées.
        </p>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void | Promise<void>
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg-primary">{label}</p>
        <p className="text-xs text-fg-muted mt-0.5">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={(v) => void onChange(v)} />
    </div>
  )
}

// ───────── Network ─────────
function NetworkSection() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.nexus.appSettings.get().then((res) => {
      if (res.ok && res.settings) {
        setAppSettings(res.settings)
        setDraft(res.settings.proxyUrl)
      }
    })
  }, [])

  async function save() {
    setSaving(true)
    const res = await window.nexus.appSettings.update({ proxyUrl: draft.trim() })
    setSaving(false)
    if (res.ok && res.settings) {
      setAppSettings(res.settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  return (
    <div>
      <SectionHeader icon={Globe} title="Réseau" description="Proxy et paramètres de connexion" />
      <div className="flex flex-col gap-4">
        <div>
          <Input
            label="URL du proxy"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://proxy.example.com:8080 (vide = connexion directe)"
            helpText="S'applique aux requêtes des addons et au chargement des images. Laisse vide pour désactiver."
          />
          <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
            <p className="text-xs text-fg-muted">
              Actuel : <span className="font-mono">{appSettings?.proxyUrl || 'connexion directe'}</span>
            </p>
            <Button onClick={save} loading={saving} leftIcon={saved ? <Check className="w-4 h-4" /> : undefined}>
              {saved ? 'Enregistré' : 'Appliquer'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────── Storage ─────────
function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await window.nexus.appSettings.getStorageUsage()
    if (res.ok && res.usage) setUsage(res.usage)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function clearCache() {
    setClearing(true)
    const res = await window.nexus.appSettings.clearCaches()
    setClearing(false)
    if (res.ok) {
      setCleared(res.cleared ?? 0)
      setTimeout(() => setCleared(null), 2500)
      void refresh()
    }
  }

  return (
    <div>
      <SectionHeader icon={HardDrive} title="Stockage" description="Utilisation réelle de l'espace disque" />
      {loading ? (
        <div className="py-10 text-center text-sm text-fg-muted">Calcul en cours…</div>
      ) : usage ? (
        <div className="flex flex-col gap-4">
          <StorageRow
            label="Téléchargements (jeux installés)"
            bytes={usage.downloadsBytes}
            path={usage.downloadsPath}
            accent="text-accent-primary"
            onOpen={
              usage.downloadsPath
                ? () => void window.nexus.system.openPath(usage.downloadsPath)
                : undefined
            }
          />
          <StorageRow
            label="Base de données SQLite"
            bytes={usage.dbBytes}
            accent="text-success"
          />
          <StorageRow
            label="Cache artwork (covers, screenshots, vidéos)"
            bytes={usage.artworkBytes}
            accent="text-success"
            indent
          />
          <StorageRow
            label="Catalogues JSON importés"
            bytes={usage.jsonSourcesBytes}
            accent="text-success"
            indent
          />
          <StorageRow
            label="Cache addons HTTP"
            bytes={usage.cacheBytes}
            accent="text-warning"
          />
          <div className="border-t border-border-soft pt-4 flex flex-col gap-2">
            <StorageRow
              label="Dossier utilisateur (BDD + paramètres + logs)"
              bytes={usage.userDataBytes}
              path={usage.userDataPath}
              accent="text-fg-secondary"
              onOpen={() => void window.nexus.system.openPath(usage.userDataPath)}
            />
            <StorageRow
              label="Total disque"
              bytes={usage.grandTotalBytes}
              accent="text-fg-primary"
              big
            />
          </div>
          <div className="flex items-center justify-between pt-2 flex-wrap gap-2">
            <p className="text-xs text-fg-muted">
              {cleared !== null && <span className="text-success">{formatBytes(cleared)} libérés</span>}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={refresh} loading={loading}>
                Rafraîchir
              </Button>
              <Button variant="outline" leftIcon={<Trash2 className="w-4 h-4" />} onClick={clearCache} loading={clearing}>
                Vider le cache addons
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StorageRow({
  label,
  bytes,
  accent,
  big,
  path,
  indent,
  onOpen,
}: {
  label: string
  bytes: number
  accent?: string
  big?: boolean
  path?: string
  indent?: boolean
  onOpen?: () => void
}) {
  return (
    <div className={indent ? 'ml-4 pl-3 border-l border-glass-border' : undefined}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="min-w-0 flex-1">
          <span className={`text-sm ${big ? 'font-semibold text-fg-primary' : 'text-fg-secondary'}`}>
            {label}
          </span>
          {path && (
            <p
              className="text-[10px] text-fg-muted font-mono truncate mt-0.5"
              title={path}
            >
              {path}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpen && (
            <button
              onClick={onOpen}
              className="text-[10px] uppercase tracking-wider text-accent-primary hover:underline"
              title="Ouvrir dans l'explorateur"
            >
              Ouvrir
            </button>
          )}
          <span
            className={`font-mono ${big ? 'text-lg font-bold' : 'text-sm'} ${accent ?? 'text-fg-secondary'}`}
          >
            {formatBytes(bytes)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ───────── Performance ─────────
function PerformanceSection() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const setAnimationsEnabled = useSettingsStore((s) => s.setAnimationsEnabled)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const res = await window.nexus.appSettings.getMetrics()
      if (!cancelled && res.ok && res.metrics) setMetrics(res.metrics)
    }
    void poll()
    const interval = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return (
    <div>
      <SectionHeader icon={Activity} title="Performance" description="Utilisation des ressources en temps réel et mode léger" />
      {metrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card padding="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-fg-muted">CPU</span>
              <span className="font-mono text-lg font-bold text-accent-primary">{metrics.cpuUsage.toFixed(1)}%</span>
            </div>
            <ProgressBar value={Math.min(100, metrics.cpuUsage)} />
          </Card>
          <Card padding="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-fg-muted">RAM</span>
              <span className="font-mono text-lg font-bold text-accent-primary">{metrics.ramMb} Mo</span>
            </div>
            <ProgressBar value={metrics.ramTotalMb > 0 ? (metrics.ramMb / metrics.ramTotalMb) * 100 : 0} />
            <p className="text-xs text-fg-muted mt-1.5">sur {Math.round(metrics.ramTotalMb / 1024)} Go au total</p>
          </Card>
          <Card padding="md" className="md:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-fg-muted">Durée de session</span>
              <span className="font-mono text-sm text-fg-secondary">{formatUptime(metrics.uptimeSeconds)}</span>
            </div>
          </Card>
        </div>
      )}

      <div className="flex items-start justify-between gap-4 pt-5 border-t border-border-soft">
        <div>
          <p className="text-sm font-medium text-fg-primary">Mode léger (désactiver les animations)</p>
          <p className="text-xs text-fg-muted mt-0.5">Supprime les transitions et réduit le flou pour minimiser la charge</p>
        </div>
        <Toggle checked={!animationsEnabled} onChange={(v) => setAnimationsEnabled(!v)} />
      </div>
    </div>
  )
}

// ───────── Security ─────────
function SecuritySection() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const res = await window.nexus.appSettings.listSessions(user.id)
    if (res.ok) setSessions(res.sessions)
    setLoading(false)
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function revoke(sessionToken: string) {
    setBusy(sessionToken)
    await window.nexus.appSettings.revokeSession(sessionToken)
    setBusy(null)
    await refresh()
  }

  async function revokeOthers() {
    if (!user || !token) return
    setBusy('others')
    await window.nexus.appSettings.revokeOtherSessions(user.id, token)
    setBusy(null)
    await refresh()
  }

  if (!user) return null

  const otherCount = sessions.filter((s) => s.token !== token).length

  return (
    <div>
      <SectionHeader icon={Lock} title="Sécurité" description="Sessions actives pour ce compte" />
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-fg-secondary">{sessions.length} session{sessions.length === 1 ? '' : 's'} active{sessions.length === 1 ? '' : 's'}</p>
        {otherCount > 0 && (
          <Button variant="outline" leftIcon={<LogOut className="w-4 h-4" />} onClick={revokeOthers} loading={busy === 'others'}>
            Déconnecter {otherCount} autre{otherCount === 1 ? '' : 's'}
          </Button>
        )}
      </div>
      {loading ? (
        <div className="py-6 text-center text-sm text-fg-muted">Chargement…</div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-fg-muted text-center py-6">Aucune session active.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => {
            const isCurrent = s.token === token
            return (
              <div key={s.token} className="flex items-center justify-between gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg-primary">
                      {isCurrent ? 'Cette session' : 'Autre session'}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-success/15 text-success">actuelle</span>
                    )}
                  </div>
                  <p className="text-xs text-fg-muted font-mono mt-0.5">
                    Ouverte le {new Date(s.issuedAt).toLocaleString()} · expire le {new Date(s.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {!isCurrent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                    onClick={() => void revoke(s.token)}
                    loading={busy === s.token}
                    className="text-error hover:text-error"
                  >
                    Révoquer
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ───────── Addons ─────────
function AddonsSection() {
  const addons = useAddonStore((s) => s.addons)
  const enabled = addons.filter((a) => a.enabled).length

  // SteamGridDB key state — loaded from app settings on mount, saved back on
  // Apply. Trimmed at the IPC layer (clamped to 200 chars too) so we don't
  // have to defensively re-validate here.
  const [sgdbKey, setSgdbKey] = useState('')
  const [sgdbHasKey, setSgdbHasKey] = useState(false)
  const [sgdbSaving, setSgdbSaving] = useState(false)
  const [sgdbSaved, setSgdbSaved] = useState(false)
  const [sgdbReveal, setSgdbReveal] = useState(false)

  // Steam Web API key — used by the achievements service to fetch
  // GetSchemaForGame. Same shape as SGDB above; we just track them
  // independently because the user might configure one without the other.
  const [steamKey, setSteamKey] = useState('')
  const [steamHasKey, setSteamHasKey] = useState(false)
  const [steamSaving, setSteamSaving] = useState(false)
  const [steamSaved, setSteamSaved] = useState(false)
  const [steamReveal, setSteamReveal] = useState(false)

  useEffect(() => {
    void window.nexus.appSettings.get().then((res) => {
      if (res.ok && res.settings) {
        setSgdbKey(res.settings.steamGridDbApiKey ?? '')
        setSgdbHasKey((res.settings.steamGridDbApiKey ?? '').length > 0)
        setSteamKey(res.settings.steamWebApiKey ?? '')
        setSteamHasKey((res.settings.steamWebApiKey ?? '').length > 0)
      }
    })
  }, [])

  async function saveSgdbKey() {
    setSgdbSaving(true)
    const res = await window.nexus.appSettings.update({ steamGridDbApiKey: sgdbKey.trim() })
    setSgdbSaving(false)
    if (res.ok && res.settings) {
      setSgdbHasKey((res.settings.steamGridDbApiKey ?? '').length > 0)
      setSgdbSaved(true)
      setTimeout(() => setSgdbSaved(false), 1500)
    }
  }

  async function saveSteamKey() {
    setSteamSaving(true)
    const res = await window.nexus.appSettings.update({ steamWebApiKey: steamKey.trim() })
    setSteamSaving(false)
    if (res.ok && res.settings) {
      setSteamHasKey((res.settings.steamWebApiKey ?? '').length > 0)
      setSteamSaved(true)
      setTimeout(() => setSteamSaved(false), 1500)
    }
  }

  return (
    <div>
      <SectionHeader icon={Puzzle} title="Addons" description="Sources additionnelles" />
      <div className="flex flex-col gap-4">
        <Card padding="md">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-fg-primary">
                {addons.length === 0 ? 'Aucun addon installé' : `${addons.length} installé${addons.length === 1 ? '' : 's'} · ${enabled} activé${enabled === 1 ? '' : 's'}`}
              </p>
              <p className="text-xs text-fg-muted mt-0.5">
                Installer, configurer et activer des sources de jeux
              </p>
            </div>
            <Link to="/addons">
              <Button variant="outline" leftIcon={<Puzzle className="w-4 h-4" />}>
                Gérer les addons
              </Button>
            </Link>
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-9 h-9 rounded-md bg-accent-secondary/15 border border-accent-secondary/40 flex items-center justify-center shrink-0">
              <ImageIcon className="w-4 h-4 text-accent-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-fg-primary flex items-center gap-2">
                SteamGridDB
                {sgdbHasKey && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                    <Check className="w-2.5 h-2.5" /> Actif
                  </span>
                )}
              </p>
              <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">
                Source d'artwork de secours — utilisée quand Steam n'a pas de correspondance pour un jeu.
                Couvre les jeux console, exclusivités, et titres niche que Steam ne référence pas.
              </p>
            </div>
          </div>

          <Input
            label="Clé API"
            type={sgdbReveal ? 'text' : 'password'}
            value={sgdbKey}
            onChange={(e) => setSgdbKey(e.target.value)}
            placeholder="Colle ta clé SteamGridDB ici"
            helpText="Gratuite — clique sur « Obtenir une clé » pour t'inscrire."
            rightSlot={
              <button
                type="button"
                onClick={() => setSgdbReveal((r) => !r)}
                className="text-xs text-fg-muted hover:text-fg-primary px-2"
              >
                {sgdbReveal ? 'Cacher' : 'Afficher'}
              </button>
            }
          />
          <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
            <a
              href="https://www.steamgriddb.com/profile/preferences/api"
              onClick={(e) => {
                e.preventDefault()
                void window.nexus.system.openExternal('https://www.steamgriddb.com/profile/preferences/api')
              }}
              className="inline-flex items-center gap-1.5 text-xs text-accent-primary hover:underline"
            >
              <ExternalLink className="w-3 h-3" /> Obtenir une clé sur steamgriddb.com
            </a>
            <Button
              onClick={saveSgdbKey}
              loading={sgdbSaving}
              leftIcon={sgdbSaved ? <Check className="w-4 h-4" /> : undefined}
            >
              {sgdbSaved ? 'Enregistré' : 'Appliquer'}
            </Button>
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-9 h-9 rounded-md bg-warning/15 border border-warning/40 flex items-center justify-center shrink-0">
              <Trophy className="w-4 h-4 text-warning" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-fg-primary flex items-center gap-2">
                Steam Web API (succès — optionnel)
                {steamHasKey && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                    <Check className="w-2.5 h-2.5" /> Actif
                  </span>
                )}
              </p>
              <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">
                <span className="text-fg-secondary">Pas obligatoire</span> — sans clé, Nexus affiche les 10 succès mis en avant par Steam (avec icônes + noms).
                Avec une clé, tu débloques la liste complète + descriptions + icônes grisées des succès verrouillés.
              </p>
            </div>
          </div>

          <Input
            label="Clé Steam Web API"
            type={steamReveal ? 'text' : 'password'}
            value={steamKey}
            onChange={(e) => setSteamKey(e.target.value)}
            placeholder="Colle ta clé Steam ici"
            helpText="Gratuite et instantanée — clique sur « Obtenir une clé » pour t'inscrire."
            rightSlot={
              <button
                type="button"
                onClick={() => setSteamReveal((r) => !r)}
                className="text-xs text-fg-muted hover:text-fg-primary px-2"
              >
                {steamReveal ? 'Cacher' : 'Afficher'}
              </button>
            }
          />
          <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
            <a
              href="https://steamcommunity.com/dev/apikey"
              onClick={(e) => {
                e.preventDefault()
                void window.nexus.system.openExternal('https://steamcommunity.com/dev/apikey')
              }}
              className="inline-flex items-center gap-1.5 text-xs text-accent-primary hover:underline"
            >
              <ExternalLink className="w-3 h-3" /> Obtenir une clé sur steamcommunity.com
            </a>
            <Button
              onClick={saveSteamKey}
              loading={steamSaving}
              leftIcon={steamSaved ? <Check className="w-4 h-4" /> : undefined}
            >
              {steamSaved ? 'Enregistré' : 'Appliquer'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ───────── Data ─────────
function DataSection() {
  const user = useAuthStore((s) => s.user)
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0)

  if (!user) return null

  async function handleExport() {
    setExporting(true)
    setExportError(null)
    setExportPath(null)
    const res = await window.nexus.appSettings.exportData(user!.id)
    setExporting(false)
    if (res.ok && res.path) {
      setExportPath(res.path)
    } else if (res.error) {
      setExportError(res.error)
    }
  }

  async function handleReset() {
    if (resetStep === 0) {
      setResetStep(1)
      setTimeout(() => setResetStep((s) => (s === 1 ? 0 : s)), 5000)
      return
    }
    if (resetStep === 1) {
      setResetStep(2)
      await window.nexus.appSettings.resetAllData()
      // App will relaunch — no further UI needed
    }
  }

  return (
    <div>
      <SectionHeader icon={Database} title="Données" description="Sauvegarde et réinitialisation" />
      <div className="flex flex-col gap-5">
        <Card padding="md">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg-primary">Exporter tes données</p>
              <p className="text-xs text-fg-muted mt-0.5">
                Bibliothèque, téléchargements, amis, activité, avis, thèmes et addons installés — au format JSON
              </p>
              {exportPath && (
                <p className="text-xs text-success mt-2 font-mono break-all flex items-start gap-1.5">
                  <Check className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>Exporté vers {exportPath}</span>
                </p>
              )}
              {exportError && (
                <p className="text-xs text-error mt-2 flex items-start gap-1.5">
                  <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" /> {exportError}
                </p>
              )}
            </div>
            <Button variant="outline" leftIcon={<ExternalLink className="w-4 h-4" />} onClick={handleExport} loading={exporting}>
              Exporter vers fichier
            </Button>
          </div>
        </Card>

        <Card padding="md" className="border-error/30">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium text-error">Réinitialiser toutes les données</p>
              <p className="text-xs text-fg-muted mt-0.5 max-w-md">
                Efface la base locale (utilisateurs, bibliothèque, téléchargements, amis, avis, thèmes, addons, paramètres) et redémarre Nexus. Cette action est irréversible.
              </p>
            </div>
            <Button
              variant={resetStep === 0 ? 'outline' : 'danger'}
              leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={handleReset}
              disabled={resetStep === 2}
            >
              {resetStep === 0 ? 'Tout réinitialiser' : resetStep === 1 ? 'Reclique pour confirmer' : 'Réinitialisation…'}
            </Button>
          </div>
        </Card>

        <div className="pt-4 flex flex-col items-center gap-2">
          <ChangelogButton />
          <p className="text-center text-xs text-fg-muted">
            Nexus Launcher · v
            {(window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__ ??
              '?.?.?'}
            {' · plugin-neutre · hors-ligne d\'abord'}
          </p>
        </div>
      </div>
    </div>
  )
}

/** "Voir les notes de version" — opens the changelog dialog in
 *  controlled (non-auto) mode so the user can browse prior releases
 *  even after dismissing the auto-pop. */
function ChangelogButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="h-7 px-3 rounded-md text-xs text-fg-secondary hover:text-accent-primary hover:bg-[var(--surface-soft-hover)] transition-colors border border-glass-border"
      >
        Voir les notes de version
      </button>
      <ChangelogDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

// ───────── Page ─────────
export default function SettingsPage() {
  const [tab, setTab] = useState('account')

  return (
    // Layout ported from ScanVerse Paramètres : narrow centred column
    // with header → horizontal pill tabs → stacked content cards.
    // Replaces the previous Nexus sidebar+content grid because the
    // user explicitly asked for the ScanVerse disposition. Pill bar
    // overflow-x scrolls horizontally on small viewports so the
    // 11-tab list never wraps awkwardly.
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-24">
      {/* Header — glassmorphism hero card with accent glow */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative mb-7 rounded-2xl glass-card p-6 overflow-hidden"
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-10 w-44 h-44 rounded-full opacity-50"
          style={{ background: 'radial-gradient(circle, rgba(124,92,255,0.45), transparent 70%)', filter: 'blur(40px)' }}
        />
        <div className="relative flex items-center gap-4">
          <div className="relative w-14 h-14 rounded-2xl bg-accent-gradient flex items-center justify-center shadow-[0_8px_24px_-8px_rgba(124,92,255,0.6)]">
            <SlidersHorizontal className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="font-display font-bold text-3xl text-fg-primary tracking-tight">
              <span className="text-gradient">Paramètres</span>
            </h1>
            <p className="text-sm text-fg-secondary mt-1">
              Gère ton compte, tes préférences et tes données.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Pill tab strip. Scrolls horizontally on mobile / narrow
          viewports — `no-scrollbar` hides the native bar so the
          11-tab strip stays clean. */}
      <div
        className="
          flex gap-1 mb-7 sm:mb-8 p-1.5 rounded-full
          -mx-4 sm:mx-0 px-4 sm:px-1.5
          overflow-x-auto no-scrollbar whitespace-nowrap
          glass-card
        "
      >
        {TAB_ITEMS.map((t) => {
          const isActive = tab === t.value
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={cn(
                'shrink-0 flex items-center justify-center gap-2 px-4 min-h-[40px] rounded-full text-sm font-semibold transition-all duration-200',
                isActive
                  ? 'bg-accent-gradient text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.5)]'
                  : 'text-fg-muted hover:text-fg-primary hover:bg-surface-soft',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Active tab content. We DON'T wrap in an outer <Card> anymore —
          each section already paints its own cards/blocks, and the
          ScanVerse layout keeps the outer column flat so card edges
          align with the tab strip above. */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
      >
        {tab === 'account' && <AccountSection />}
        {tab === 'general' && <GeneralSection />}
        {tab === 'personalisation' && <PersonalisationSection />}
        {tab === 'downloads' && <DownloadsSection />}
        {tab === 'notifications' && <NotificationsSection />}
        {tab === 'network' && <NetworkSection />}
        {tab === 'storage' && <StorageSection />}
        {tab === 'performance' && <PerformanceSection />}
        {tab === 'security' && <SecuritySection />}
        {tab === 'addons' && <AddonsSection />}
        {tab === 'data' && <DataSection />}
      </motion.div>
    </div>
  )
}
