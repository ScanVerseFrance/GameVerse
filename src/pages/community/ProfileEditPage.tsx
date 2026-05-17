import { useEffect, useMemo, useState, useRef, type ChangeEvent } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  User as UserIcon,
  Image as ImageIcon,
  Sparkles,
  Music,
  Search,
  Check,
  X,
  AlertCircle,
  Save,
  Eye,
  Palette,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Username } from '@/components/common/Username'
import {
  NAMEPLATES,
  PROFILE_EFFECTS,
  AVATAR_DECORATIONS,
  NONE_NAMEPLATE,
  NONE_EFFECT,
  NONE_DECORATION,
  findPlaque,
  findEffect,
  findDecoration,
} from '@/config/profileCosmetics'
import { cn } from '@/utils/cn'

// File-size ceilings — same as Settings (and ComicScan): 10 MB stored as a
// data URL on the user row.
const AVATAR_MAX_BYTES = 10 * 1024 * 1024
const BANNER_MAX_BYTES = 10 * 1024 * 1024

type SectionKey = 'identity' | 'plaque' | 'effect' | 'decoration' | 'music'

const SECTIONS: Array<{ value: SectionKey; label: string; icon: typeof UserIcon; count?: number }> = [
  { value: 'identity', label: 'Identité', icon: UserIcon },
  { value: 'plaque', label: 'Plaque', icon: Palette, count: NAMEPLATES.length },
  { value: 'effect', label: 'Effet', icon: Sparkles, count: PROFILE_EFFECTS.length },
  { value: 'decoration', label: 'Décoration', icon: ImageIcon, count: AVATAR_DECORATIONS.length },
  { value: 'music', label: 'Musique', icon: Music },
]

const USERNAME_ANIMATIONS: Array<{ value: 'none' | 'shimmer' | 'rainbow' | 'pulse'; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'rainbow', label: 'Arc-en-ciel' },
  { value: 'pulse', label: 'Pulsation' },
]

const COLOR_SWATCHES = [
  '',
  '#88c057',
  '#5ba32b',
  '#66c0f4',
  '#1a9fff',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#06b6d4',
  '#eab308',
  '#a78bfa',
]

function readAsDataUrl(f: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(f)
  })
}

/**
 * Full-page profile editor (replaces the old modal at /community/profile/:id).
 * Two-column layout: left = section nav, right = section content. A persistent
 * live preview lives at the very top so the user sees the impact of every
 * change without scrolling away from a tile grid.
 *
 * All edits are local until the user clicks "Enregistrer". Identity edits
 * (avatar/banner/bio/etc.) go through useAuthStore.updateProfile; cosmetic
 * edits go through window.nexus.profile.updateCosmetics. We commit them in
 * parallel on save.
 */
export default function ProfileEditPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  const [section, setSection] = useState<SectionKey>('identity')
  const [query, setQuery] = useState('')

  // Identity drafts — sync with the auth user on mount and on user change.
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [usernameColor, setUsernameColor] = useState(user?.usernameColor ?? '')
  const [usernameAnimation, setUsernameAnimation] = useState<
    'none' | 'shimmer' | 'rainbow' | 'pulse'
  >(user?.usernameAnimation ?? 'none')

  // Cosmetic drafts. Loaded once from the user (which already has the
  // basics) — we read the full record via getCosmetics to be sure we have
  // music start/end too (not exposed on PublicUser).
  const [plaqueId, setPlaqueId] = useState<string>(NONE_NAMEPLATE.id)
  const [effectId, setEffectId] = useState<string>(NONE_EFFECT.id)
  const [decorationId, setDecorationId] = useState<string>(NONE_DECORATION.id)
  const [musicUrl, setMusicUrl] = useState('')

  const [loadingCosmetics, setLoadingCosmetics] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Block edits if the URL userId does not match the current session — there's
  // no "edit someone else's profile" path and we don't want to silently misroute.
  const isSelf = user?.id === userId

  useEffect(() => {
    if (!user) return
    setDisplayName(user.displayName ?? '')
    setBio(user.bio ?? '')
    setEmail(user.email ?? '')
    setUsernameColor(user.usernameColor ?? '')
    setUsernameAnimation(user.usernameAnimation ?? 'none')
  }, [user?.id])

  useEffect(() => {
    if (!userId) return
    setLoadingCosmetics(true)
    void window.nexus.profile.getCosmetics(userId).then((res) => {
      if (res.ok && res.cosmetics) {
        setPlaqueId(res.cosmetics.plaqueId ?? NONE_NAMEPLATE.id)
        setEffectId(res.cosmetics.profileEffectId ?? NONE_EFFECT.id)
        setDecorationId(res.cosmetics.avatarDecorationId ?? NONE_DECORATION.id)
        setMusicUrl(res.cosmetics.profileMusicUrl ?? '')
      }
      setLoadingCosmetics(false)
    })
  }, [userId])

  // Reset the search box when switching tabs — last filter shouldn't leak.
  useEffect(() => {
    setQuery('')
  }, [section])

  const filteredPlaques = useMemo(() => {
    const all = [NONE_NAMEPLATE, ...NAMEPLATES]
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((n) => n.name.toLowerCase().includes(q))
  }, [query])

  const filteredEffects = useMemo(() => {
    const all = [NONE_EFFECT, ...PROFILE_EFFECTS]
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((n) => n.name.toLowerCase().includes(q))
  }, [query])

  const filteredDecorations = useMemo(() => {
    const all = [NONE_DECORATION, ...AVATAR_DECORATIONS]
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((n) => n.name.toLowerCase().includes(q))
  }, [query])

  async function handleAvatar(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !user) return
    if (f.size > AVATAR_MAX_BYTES) {
      setError(`Avatar trop volumineux (max ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} Mo).`)
      return
    }
    setError(null)
    const url = await readAsDataUrl(f)
    if (url) await updateProfile({ avatarPath: url })
  }

  async function handleBanner(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !user) return
    if (f.size > BANNER_MAX_BYTES) {
      setError(`Bannière trop volumineuse (max ${Math.round(BANNER_MAX_BYTES / 1024 / 1024)} Mo).`)
      return
    }
    setError(null)
    const url = await readAsDataUrl(f)
    if (url) await updateProfile({ bannerPath: url })
  }

  async function handleSave() {
    if (!user) return
    setSaving(true)
    setError(null)

    // Both endpoints can be hit in parallel — they touch different DB rows
    // (the `users` table for identity, the `profile_cosmetics` table for
    // cosmetics) so there's no ordering constraint.
    const [identityOk, cosmeticsRes] = await Promise.all([
      updateProfile({
        displayName,
        bio,
        email: email || '',
        usernameColor,
        usernameAnimation,
      }),
      window.nexus.profile.updateCosmetics(user.id, {
        plaqueId: plaqueId === NONE_NAMEPLATE.id ? null : plaqueId,
        profileEffectId: effectId === NONE_EFFECT.id ? null : effectId,
        avatarDecorationId: decorationId === NONE_DECORATION.id ? null : decorationId,
        profileMusicUrl: musicUrl.trim() || null,
      }),
    ])

    setSaving(false)
    if (!identityOk || !cosmeticsRes.ok) {
      setError(cosmeticsRes.error ?? 'Échec de la sauvegarde — réessaye plus tard.')
      return
    }
    setSavedAt(Date.now())
    setTimeout(() => setSavedAt(null), 2000)
  }

  // Compute resolved cosmetic objects for the live preview.
  const plaque = findPlaque(plaqueId)
  const effect = findEffect(effectId)
  const decoration = findDecoration(decorationId)
  const plaqueBg = plaque.gradientCss ?? undefined
  const plaqueBorder = plaque.darkHex
    ? `1px solid ${plaque.darkHex}66`
    : '1px solid rgba(255, 255, 255, 0.08)'

  if (!user) {
    return (
      <div className="py-20 text-center text-sm text-fg-muted">Chargement du profil…</div>
    )
  }

  if (!isSelf) {
    return (
      <div className="px-10 py-10 max-w-3xl mx-auto">
        <Card padding="lg" className="border-error/30 bg-error/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-fg-primary">Accès refusé</p>
              <p className="text-xs text-fg-muted mt-1">
                Seul le propriétaire d'un profil peut le modifier.
              </p>
              <Link to={`/community/profile/${userId}`} className="text-xs text-accent-primary hover:underline mt-3 inline-block">
                Retour au profil
              </Link>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <button
          onClick={() => navigate(`/community/profile/${user.id}`)}
          className="inline-flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg-primary"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Retour au profil
        </button>
        <div className="flex items-center gap-2">
          <Link to={`/community/profile/${user.id}`}>
            <Button variant="outline" leftIcon={<Eye className="w-4 h-4" />}>
              Aperçu public
            </Button>
          </Link>
          <Button
            onClick={handleSave}
            loading={saving}
            leftIcon={savedAt ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          >
            {savedAt ? 'Enregistré' : 'Enregistrer'}
          </Button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="font-display font-black text-3xl text-fg-primary">Personnaliser le profil</h1>
        <p className="text-sm text-fg-secondary mt-1">
          Modifie ton identité, ta plaque, ton effet, ta décoration d'avatar et ta musique de profil.
        </p>
      </motion.div>

      {/* Persistent live preview — sticks at the top so the user sees the
          end result while picking through the long cosmetic grids. */}
      <Card variant="solid" padding="none" className="overflow-hidden relative mt-6">
        <div
          aria-hidden
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
                    'radial-gradient(circle at 0% 0%, rgba(102, 192, 244, 0.25), transparent 55%), radial-gradient(circle at 100% 100%, rgba(91, 163, 43, 0.20), transparent 55%), linear-gradient(135deg, #2a475e, #1b2838)',
                }
          }
        />
        {effect.parts.length > 0 && (
          <div className="absolute top-0 left-0 right-0 h-32 overflow-hidden pointer-events-none" aria-hidden>
            {effect.parts.map((p) => (
              <img
                key={p.index}
                src={p.file}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
            ))}
          </div>
        )}
        <div className="relative px-6 pb-5 -mt-10 flex items-end gap-4 flex-wrap md:flex-nowrap">
          <div className="relative w-20 h-20 shrink-0">
            <div className="absolute inset-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center border-4 border-bg-primary">
              {user.avatarPath ? (
                <img src={user.avatarPath} alt="" className="w-full h-full object-cover rounded-full" />
              ) : (
                <span className="text-2xl font-bold text-white">
                  {(displayName || user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            {decoration.file && (
              <img
                src={decoration.file}
                alt=""
                aria-hidden
                draggable={false}
                style={{
                  maxWidth: 'none',
                  maxHeight: 'none',
                  willChange: 'transform',
                }}
                className="absolute -inset-2 w-[calc(100%+1rem)] h-[calc(100%+1rem)] object-contain pointer-events-none select-none"
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="relative inline-block px-4 py-1.5 rounded-md overflow-hidden"
              style={{ border: plaqueBorder }}
            >
              {plaque.file && (
                <video
                  src={plaque.file}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  className="absolute inset-0 w-full h-full object-cover"
                  aria-hidden
                />
              )}
              {plaqueBg && (
                <div aria-hidden className="absolute inset-0" style={{ background: plaqueBg }} />
              )}
              <Username
                user={{
                  username: user.username,
                  displayName: displayName || user.displayName,
                  usernameColor,
                  usernameAnimation,
                }}
                className="relative font-display font-bold text-2xl text-fg-primary"
              />
            </div>
            <p className="text-xs text-fg-muted font-mono mt-1">
              @{user.username} · aperçu en direct
            </p>
          </div>
        </div>
      </Card>

      {/* Two-column editor */}
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 mt-6">
        <aside className="md:sticky md:top-4 self-start">
          <Card padding="sm">
            <nav className="flex flex-col gap-1" role="tablist">
              {SECTIONS.map((s) => {
                const Icon = s.icon
                const active = section === s.value
                return (
                  <button
                    key={s.value}
                    onClick={() => setSection(s.value)}
                    className={cn(
                      'flex items-center gap-2.5 h-10 px-3 rounded-md text-sm font-medium text-left transition-colors border',
                      active
                        ? 'bg-accent-primary/15 text-accent-primary border-accent-primary/30'
                        : 'text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] border-transparent'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate flex-1">{s.label}</span>
                    {s.count != null && (
                      <span className="text-[10px] font-mono text-fg-muted">{s.count}</span>
                    )}
                  </button>
                )
              })}
            </nav>
          </Card>
        </aside>

        <section className="min-w-0">
          <Card padding="lg">
            {section === 'identity' && (
              <IdentitySection
                user={user}
                displayName={displayName}
                setDisplayName={setDisplayName}
                email={email}
                setEmail={setEmail}
                bio={bio}
                setBio={setBio}
                usernameColor={usernameColor}
                setUsernameColor={setUsernameColor}
                usernameAnimation={usernameAnimation}
                setUsernameAnimation={setUsernameAnimation}
                onAvatar={handleAvatar}
                onBanner={handleBanner}
                onClearAvatar={() => void updateProfile({ avatarPath: '' })}
                onClearBanner={() => void updateProfile({ bannerPath: '' })}
              />
            )}

            {section === 'plaque' && (
              <CosmeticGrid
                title="Plaque (nameplate)"
                description="Le fond animé derrière ton pseudo. Chaque plaque ramène sa palette pour teinter la carte."
                query={query}
                onQuery={setQuery}
                loading={loadingCosmetics}
              >
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {filteredPlaques.map((n) => (
                    <PlaqueTile
                      key={n.id}
                      nameplate={n}
                      selected={plaqueId === n.id}
                      onSelect={() => setPlaqueId(n.id)}
                    />
                  ))}
                </div>
              </CosmeticGrid>
            )}

            {section === 'effect' && (
              <CosmeticGrid
                title="Effet de profil"
                description="Superposition animée sur la bannière. Plusieurs couches PNG empilées."
                query={query}
                onQuery={setQuery}
                loading={loadingCosmetics}
              >
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {filteredEffects.map((e) => (
                    <EffectTile
                      key={e.id}
                      effect={e}
                      selected={effectId === e.id}
                      onSelect={() => setEffectId(e.id)}
                    />
                  ))}
                </div>
              </CosmeticGrid>
            )}

            {section === 'decoration' && (
              <CosmeticGrid
                title="Décoration d'avatar"
                description="Cadre transparent posé par-dessus la photo de profil."
                query={query}
                onQuery={setQuery}
                loading={loadingCosmetics}
              >
                <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-3">
                  {filteredDecorations.map((d) => (
                    <DecorationTile
                      key={d.id}
                      decoration={d}
                      selected={decorationId === d.id}
                      onSelect={() => setDecorationId(d.id)}
                    />
                  ))}
                </div>
              </CosmeticGrid>
            )}

            {section === 'music' && (
              <MusicSection musicUrl={musicUrl} setMusicUrl={setMusicUrl} />
            )}
          </Card>
        </section>
      </div>

      {error && (
        <div className="mt-5 flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {/* Sticky bottom action bar */}
      <div className="sticky bottom-0 mt-8 -mx-8 px-8 py-4 bg-bg-secondary/95 backdrop-blur-md border-t border-border-soft flex items-center justify-between gap-3 flex-wrap z-10">
        <p className="text-xs text-fg-muted">
          Les modifications d'avatar et de bannière sont appliquées instantanément.
          Le reste est enregistré quand tu cliques sur « Enregistrer ».
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/community/profile/${user.id}`)}>
            Annuler
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            leftIcon={savedAt ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          >
            {savedAt ? 'Enregistré' : 'Enregistrer'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ──────────────── Identity section ──────────────── */

interface IdentityProps {
  user: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>
  displayName: string
  setDisplayName: (v: string) => void
  email: string
  setEmail: (v: string) => void
  bio: string
  setBio: (v: string) => void
  usernameColor: string
  setUsernameColor: (v: string) => void
  usernameAnimation: 'none' | 'shimmer' | 'rainbow' | 'pulse'
  setUsernameAnimation: (v: 'none' | 'shimmer' | 'rainbow' | 'pulse') => void
  onAvatar: (e: ChangeEvent<HTMLInputElement>) => void
  onBanner: (e: ChangeEvent<HTMLInputElement>) => void
  onClearAvatar: () => void
  onClearBanner: () => void
}

function IdentitySection(p: IdentityProps) {
  const avatarRef = useRef<HTMLInputElement>(null)
  const bannerRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display font-bold text-lg text-fg-primary mb-1">Identité</h2>
        <p className="text-sm text-fg-secondary">
          Avatar, bannière, pseudo affiché, bio et stylisation du nom.
        </p>
      </div>

      {/* Avatar + banner uploads */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
            Avatar
          </label>
          <div className="flex items-center gap-4 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
            <div className="w-16 h-16 rounded-full bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
              {p.user.avatarPath ? (
                <img src={p.user.avatarPath} alt="" className="w-full h-full object-cover" />
              ) : (
                <ImageIcon className="w-6 h-6 text-fg-muted" />
              )}
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <input
                ref={avatarRef}
                type="file"
                accept="image/*,image/gif"
                onChange={p.onAvatar}
                className="hidden"
              />
              <button
                onClick={() => avatarRef.current?.click()}
                className="text-sm font-medium text-accent-primary hover:underline self-start"
              >
                Importer un avatar
              </button>
              {p.user.avatarPath && (
                <button
                  onClick={p.onClearAvatar}
                  className="text-xs text-fg-muted hover:text-error self-start"
                >
                  Retirer
                </button>
              )}
              <p className="text-[10px] text-fg-muted">JPG, PNG, GIF · 10 Mo max</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
            Bannière
          </label>
          <div className="flex items-center gap-4 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
            <div
              className="w-24 h-14 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden shrink-0"
              style={
                p.user.bannerPath
                  ? {
                      backgroundImage: `url(${p.user.bannerPath})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }
                  : {
                      background:
                        'linear-gradient(135deg, rgba(102, 192, 244, 0.3), rgba(91, 163, 43, 0.25))',
                    }
              }
            />
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <input
                ref={bannerRef}
                type="file"
                accept="image/*,image/gif"
                onChange={p.onBanner}
                className="hidden"
              />
              <button
                onClick={() => bannerRef.current?.click()}
                className="text-sm font-medium text-accent-primary hover:underline self-start"
              >
                Importer une bannière
              </button>
              {p.user.bannerPath && (
                <button
                  onClick={p.onClearBanner}
                  className="text-xs text-fg-muted hover:text-error self-start"
                >
                  Retirer
                </button>
              )}
              <p className="text-[10px] text-fg-muted">JPG, PNG, GIF · 10 Mo max</p>
            </div>
          </div>
        </div>
      </div>

      {/* Text fields */}
      <Input label="Nom affiché" value={p.displayName} onChange={(e) => p.setDisplayName(e.target.value)} />
      <Input
        label="E-mail"
        type="email"
        value={p.email}
        onChange={(e) => p.setEmail(e.target.value)}
        helpText="Optionnel — sert à récupérer le compte. Reste local à ta machine."
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Bio</label>
        <textarea
          value={p.bio}
          onChange={(e) => p.setBio(e.target.value)}
          rows={3}
          maxLength={300}
          placeholder="Parle un peu de toi aux autres joueurs…"
          className="bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] hover:border-[var(--surface-soft-border)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none focus:shadow-[0_0_0_3px_rgba(136,192,87,0.20)] rounded-md px-3.5 py-3 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
        />
        <span className="text-xs text-fg-muted self-end">{p.bio.length}/300</span>
      </div>

      {/* Username styling */}
      <div className="pt-4 border-t border-border-soft">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary mb-3">
          Stylisation du pseudo
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
                  onClick={() => p.setUsernameColor(c)}
                  className={cn(
                    'w-7 h-7 rounded-full border-2 transition-all',
                    (p.usernameColor || '') === c
                      ? 'border-fg-primary scale-110'
                      : 'border-transparent hover:scale-105'
                  )}
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
              value={p.usernameColor}
              onChange={(e) => p.setUsernameColor(e.target.value)}
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
                  onClick={() => p.setUsernameAnimation(a.value)}
                  className={cn(
                    'h-10 rounded-md text-xs font-medium border transition-colors',
                    p.usernameAnimation === a.value
                      ? 'border-accent-primary/60 bg-accent-primary/10 text-fg-primary'
                      : 'border-glass-border text-fg-secondary hover:bg-[var(--surface-soft)]'
                  )}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ──────────────── Cosmetic grid wrapper ──────────────── */

function CosmeticGrid({
  title,
  description,
  query,
  onQuery,
  loading,
  children,
}: {
  title: string
  description: string
  query: string
  onQuery: (v: string) => void
  loading: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display font-bold text-lg text-fg-primary mb-1">{title}</h2>
        <p className="text-sm text-fg-secondary">{description}</p>
      </div>

      <div className="flex items-center gap-2 h-10 px-3 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60">
        <Search className="w-4 h-4 text-fg-muted" />
        <input
          type="text"
          placeholder="Filtrer par nom…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
        />
        {query && (
          <button onClick={() => onQuery('')} className="text-fg-muted hover:text-fg-primary">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-fg-muted text-center py-10">Chargement…</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto -mx-2 px-2">{children}</div>
      )}
    </div>
  )
}

/* ──────────────── Music section ──────────────── */

function MusicSection({
  musicUrl,
  setMusicUrl,
}: {
  musicUrl: string
  setMusicUrl: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display font-bold text-lg text-fg-primary mb-1">Musique de profil</h2>
        <p className="text-sm text-fg-secondary">
          Une piste YouTube qui boucle sur ta page profil. Laisse vide pour la retirer.
        </p>
      </div>
      <input
        type="text"
        value={musicUrl}
        onChange={(e) => setMusicUrl(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=… ou https://youtu.be/…"
        maxLength={300}
        className="h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary placeholder:text-fg-muted transition-all"
      />
      <p className="text-[11px] text-fg-muted leading-relaxed">
        La piste sera incrustée via le lecteur YouTube. Elle est visible par les autres utilisateurs
        qui consultent ton profil. Aucun audio ne joue tant que le visiteur n'ouvre pas le lecteur.
      </p>
    </div>
  )
}

/* ──────────────── Tiles (selected badge, plaque, effect, decoration) ──────────────── */

function SelectedBadge() {
  return (
    <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center shadow-glow">
      <Check className="w-3 h-3 text-white" />
    </div>
  )
}

function PlaqueTile({
  nameplate,
  selected,
  onSelect,
}: {
  nameplate: ReturnType<typeof findPlaque>
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative rounded-md overflow-hidden border transition-all aspect-[4/3]',
        selected
          ? 'border-accent-primary/60 ring-2 ring-accent-primary/30'
          : 'border-glass-border hover:border-fg-muted/40'
      )}
      title={nameplate.name}
    >
      {nameplate.file ? (
        <>
          <video
            src={nameplate.file}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            className="absolute inset-0 w-full h-full object-cover"
          />
          {nameplate.gradientCss && (
            <div aria-hidden className="absolute inset-0" style={{ background: nameplate.gradientCss }} />
          )}
        </>
      ) : (
        <div className="absolute inset-0 bg-bg-tertiary flex items-center justify-center text-fg-muted text-xs">
          Sans plaque
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
        <p className="text-[11px] font-medium text-white truncate">{nameplate.name}</p>
      </div>
      {selected && <SelectedBadge />}
    </button>
  )
}

function EffectTile({
  effect,
  selected,
  onSelect,
}: {
  effect: ReturnType<typeof findEffect>
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative rounded-md overflow-hidden border transition-all aspect-[4/3]',
        selected
          ? 'border-accent-primary/60 ring-2 ring-accent-primary/30'
          : 'border-glass-border hover:border-fg-muted/40'
      )}
      title={effect.name}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-bg-secondary to-bg-tertiary" />
      {effect.parts.map((p) => (
        <img
          key={p.index}
          src={p.file}
          alt=""
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
      ))}
      <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
        <p className="text-[11px] font-medium text-white truncate">{effect.name}</p>
      </div>
      {selected && <SelectedBadge />}
    </button>
  )
}

function DecorationTile({
  decoration,
  selected,
  onSelect,
}: {
  decoration: ReturnType<typeof findDecoration>
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative rounded-md border transition-all aspect-square overflow-hidden',
        selected
          ? 'border-accent-primary/60 ring-2 ring-accent-primary/30'
          : 'border-glass-border hover:border-fg-muted/40'
      )}
      title={decoration.name}
    >
      <div className="absolute inset-0 flex items-center justify-center bg-bg-tertiary">
        <div className="w-14 h-14 rounded-full bg-accent-gradient flex items-center justify-center text-white font-bold text-lg">
          AB
        </div>
        {decoration.file && (
          <img
            src={decoration.file}
            alt=""
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/90 to-transparent">
        <p className="text-[10px] font-medium text-white truncate">{decoration.name}</p>
      </div>
      {selected && <SelectedBadge />}
    </button>
  )
}
