import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cloud,
  CloudOff,
  Loader2,
  AlertCircle,
  CheckCircle2,
  UserPlus,
  LogIn,
  RefreshCw,
  WifiOff,
} from 'lucide-react'
import { useCloudStore } from '@/stores/cloud.store'
import { PasswordStrength } from '@/components/common/PasswordStrength'
import { cn } from '@/utils/cn'

/**
 * Full-screen mandatory Nexus Cloud authentication gate.
 *
 * Mounted by the router AuthGate when the local user is signed in but
 * Nexus Cloud has no token. Blocks the entire app until the user
 * either registers a Nexus account or signs into an existing one —
 * the close button is intentionally absent.
 *
 * Why this design (not the old skippable modal):
 *   - GameVerse v0.2+ moves the social graph, presence, chat and
 *     save sync entirely into the cloud. A user who never signs in
 *     would see broken features ("Aucun ami" forever) without
 *     understanding why. Forcing the sign-in funnel at boot avoids
 *     that confusion.
 *   - Local-only library/downloads still work post-auth (offline
 *     mode kicks in transparently when the network drops), so this
 *     isn't "Steam Always Online" — it's "first-time setup".
 *
 * UX:
 *   - Hero pane on the left explains what Nexus Cloud unlocks.
 *   - Form on the right defaults to register (the assumption being
 *     this is a first-time install) with a "Déjà un compte ?" toggle
 *     to the login flow.
 *   - When the server is unreachable (offline status), we show a
 *     "Réessayer" button that re-attempts the bootConnect.
 */
export function CloudAuthGate() {
  const status = useCloudStore((s) => s.status)
  const reason = useCloudStore((s) => s.reason)
  const login = useCloudStore((s) => s.login)
  const register = useCloudStore((s) => s.register)
  const reconnect = useCloudStore((s) => s.reconnect)

  const [tab, setTab] = useState<'login' | 'register'>('register')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  // Login-only field. Kept separate from `email` so a half-typed
  // register email doesn't leak into the login form when the user
  // toggles back and forth — and so the placeholder/autocomplete
  // can be tuned per intent.
  const [loginIdentifier, setLoginIdentifier] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // v0.2.1 removed the user-overridable API URL editor — the prod
  // URL is now hardcoded in cloud.service.ts. Leaving the editor
  // generated more support traffic than it solved (users typing
  // `api.scanverse.online` instead of `nexus.scanverse.online`,
  // missing https://, etc.). Dev-mode override is via the
  // NEXUS_CLOUD_URL env var, not the UI.

  async function handleSubmit() {
    setBusy(true)
    setError(null)
    const res =
      tab === 'login'
        ? await login(loginIdentifier.trim(), password)
        : await register({
            username: username.trim(),
            password,
            email: email.trim(),
            displayName: displayName.trim(),
          })
    setBusy(false)
    if (res.ok) {
      setSuccess(true)
      // The store flips status to 'connected' which unmounts the gate
      // — no manual close needed.
    } else {
      setError(res.error)
    }
  }

  // Form validation. Login: identifier (email-shaped OR a 3+ char
  // legacy username) + password. Register: full quartet.
  const loginIdValid =
    loginIdentifier.trim().length >= 3 &&
    // Accept anything with an `@` (email) or anything else 3+ chars
    // (username). Backend disambiguates server-side.
    (loginIdentifier.includes('@') ||
      /^[a-zA-Z0-9_.-]+$/.test(loginIdentifier.trim()))
  const canSubmit =
    !busy &&
    !success &&
    password.length >= 8 &&
    (tab === 'login'
      ? loginIdValid
      : username.trim().length >= 3 &&
        email.trim().length > 3 &&
        displayName.trim().length > 0)

  // While status is 'connecting' (initial bootConnect), don't show
  // the form yet — it'd flash for a fraction of a second on a fast
  // connect. Show a centered spinner instead.
  if (status === 'connecting') {
    return (
      <div className="fixed inset-0 z-[1000] bg-bg-primary flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-fg-secondary">
          <Loader2 className="w-8 h-8 animate-spin text-accent-primary" />
          <p className="text-sm font-mono">Connexion à Nexus Cloud…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[1000] bg-bg-primary overflow-hidden flex">
      {/* ── Hero / value-proposition pane ────────────────────────── */}
      <aside className="hidden lg:flex w-[44%] flex-col justify-between p-12 relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 20% 30%, rgba(102,192,244,0.20), transparent 55%), radial-gradient(circle at 80% 70%, rgba(91,163,43,0.18), transparent 55%), linear-gradient(135deg, #1b2838 0%, #0b1622 100%)',
          }}
        />
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 mb-8">
            <div className="w-10 h-10 rounded-lg bg-accent-gradient flex items-center justify-center shadow-glow">
              <Cloud className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-black text-2xl text-white">
              Nexus Cloud
            </span>
          </div>
          <h1 className="font-display font-black text-4xl xl:text-5xl text-white leading-tight mb-6">
            Tes parties,
            <br />
            partout où tu joues.
          </h1>
          <ul className="flex flex-col gap-3 text-fg-secondary text-sm max-w-md">
            <Bullet>
              <strong className="text-fg-primary">Saves cloud</strong> — tes
              parties suivent ton compte, pas ton PC.
            </Bullet>
            <Bullet>
              <strong className="text-fg-primary">Amis &amp; chat</strong> — vois
              qui joue à quoi en direct, discute sans Discord.
            </Bullet>
            <Bullet>
              <strong className="text-fg-primary">Présence riche</strong> — tes
              amis savent à quel jeu tu joues sans que t'aies rien à faire.
            </Bullet>
            <Bullet>
              <strong className="text-fg-primary">Synchronisation</strong> —
              succès, profil, customisation partagés entre tes machines.
            </Bullet>
          </ul>
        </div>
        <div className="relative z-10 text-[11px] text-fg-muted leading-relaxed">
          Le compte est gratuit, 2 Go de saves cloud inclus. Une fois connecté,
          la bibliothèque locale reste utilisable même sans internet.
        </div>
      </aside>

      {/* ── Form pane ────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-md"
        >
          {/* Status banner — non-blocking; tells the user what's up
              when the server is unreachable. The URL editor that used
              to live here was removed in v0.2.1; users now just get
              "réessayer la connexion" — the URL is hardcoded. */}
          {status === 'offline' && (
            <div className="mb-4 p-3 rounded-md border border-warning/30 bg-warning/10 flex items-start gap-2">
              <WifiOff className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-warning">
                  Serveur Nexus Cloud injoignable
                </p>
                <p className="text-[11px] text-fg-muted mt-1 leading-snug">
                  {reason ?? 'Vérifie ta connexion internet.'}
                </p>
                <div className="mt-2 inline-flex items-center gap-3">
                  <button
                    onClick={() => void reconnect()}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-warning hover:text-fg-primary"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Réessayer la connexion
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* URL editor removed in v0.2.1 — see header comment. */}

          {/* Heading morphs between modes — same slot, content swaps
              with a soft cross-fade so the tab toggle feels like one
              UI mutating rather than two screens swapping. */}
          <div className="mb-6 min-h-[68px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <h2 className="font-display font-black text-3xl text-fg-primary">
                  {tab === 'register' ? 'Crée ton compte' : 'Connecte-toi'}
                </h2>
                <p className="text-sm text-fg-secondary mt-2">
                  {tab === 'register'
                    ? 'Tous les champs sont requis. Tu pourras tout modifier plus tard.'
                    : 'Entre ton e-mail et ton mot de passe.'}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Tabs */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-[var(--surface-soft)] border border-glass-border mb-5">
            <button
              onClick={() => {
                setTab('register')
                setError(null)
              }}
              className={cn(
                'h-9 rounded-sm text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
                tab === 'register'
                  ? 'bg-bg-secondary text-fg-primary shadow-sm'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Créer un compte
            </button>
            <button
              onClick={() => {
                setTab('login')
                setError(null)
              }}
              className={cn(
                'h-9 rounded-sm text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
                tab === 'login'
                  ? 'bg-bg-secondary text-fg-primary shadow-sm'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              <LogIn className="w-3.5 h-3.5" />
              Se connecter
            </button>
          </div>

          {/* History: v0.1.1 used framer-motion `layout` everywhere → re-
              fired on every keystroke, jitter. v0.1.2-0.1.4 pinned a
              fat min-h-[280px] to stop reflow → looked stupid in login
              mode (200px of dead space). v0.1.5 lands on a CSS-grid
              trick: the morph container has `grid-template-rows: 1fr`
              and lets browser reflow the size naturally as content
              swaps, while AnimatePresence cross-fades the variants.
              No framer layout interpolation = no input-keystroke
              jitter; no fixed height = no absurd spacing. */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) void handleSubmit()
            }}
            className="flex flex-col gap-3"
          >
            <div className="relative">
              <AnimatePresence mode="wait" initial={false}>
                {tab === 'login' ? (
                  <motion.div
                    key="login-fields"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col gap-3"
                  >
                    <Field
                      label="E-mail"
                      hint="L'adresse de ton compte Nexus"
                      value={loginIdentifier}
                      onChange={setLoginIdentifier}
                      placeholder="ton-email@scanverse.fr"
                      type="email"
                      autoComplete="email"
                      disabled={busy || success}
                      required
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="register-fields"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col gap-3"
                  >
                    <Field
                      label="Nom d'utilisateur (@)"
                      hint="3-32 caractères · lettres, chiffres, . _ -"
                      value={username}
                      onChange={setUsername}
                      placeholder="ton-pseudo"
                      autoComplete="username"
                      disabled={busy || success}
                      required
                    />
                    <Field
                      label="E-mail"
                      hint="Pour récupérer ton compte"
                      value={email}
                      onChange={setEmail}
                      placeholder="ton-email@scanverse.fr"
                      type="email"
                      autoComplete="email"
                      disabled={busy || success}
                      required
                    />
                    <Field
                      label="Nom affiché"
                      hint="Le nom visible par tes amis"
                      value={displayName}
                      onChange={setDisplayName}
                      placeholder="Ton nom"
                      autoComplete="nickname"
                      disabled={busy || success}
                      required
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <Field
              label="Mot de passe"
              hint="8 caractères minimum"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              type="password"
              autoComplete={
                tab === 'register' ? 'new-password' : 'current-password'
              }
              disabled={busy || success}
              required
            />
            {/* Strength meter — only at register time. We pass the
                username so the scorer can penalise "password contains
                your username" combos. Simple opacity fade — no height
                animation so it doesn't disturb the form layout. */}
            {tab === 'register' && (
              <PasswordStrength
                password={password}
                username={username}
              />
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span className="block">{error}</span>
                  {/* URL editor link removed in v0.2.1 — the URL is
                      hardcoded. Network errors now just suggest
                      retrying. */}
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="h-12 mt-2 rounded-md bg-accent-gradient text-white font-bold text-sm inline-flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-glow transition-shadow"
            >
              {success ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Connecté
                </>
              ) : busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {tab === 'register' ? 'Création du compte…' : 'Connexion…'}
                </>
              ) : (
                <>
                  <Cloud className="w-4 h-4" />
                  {tab === 'register' ? 'Créer mon compte Nexus' : 'Se connecter'}
                </>
              )}
            </button>

            <p className="text-[11px] text-fg-muted text-center mt-2 leading-relaxed">
              {tab === 'register' ? (
                <>
                  Déjà un compte ?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setTab('login')
                      setError(null)
                    }}
                    className="text-accent-primary hover:underline"
                  >
                    Se connecter
                  </button>
                </>
              ) : (
                <>
                  Pas encore inscrit ?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setTab('register')
                      setError(null)
                    }}
                    className="text-accent-primary hover:underline"
                  >
                    Créer un compte
                  </button>
                </>
              )}
            </p>
          </form>
        </motion.div>
      </main>
    </div>
  )
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CloudOff className="hidden" aria-hidden />
      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-accent-primary shrink-0" />
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  disabled,
  required,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'email'
  autoComplete?: string
  disabled?: boolean
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider inline-flex items-center justify-between gap-2">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] font-mono normal-case tracking-normal text-fg-muted">
            {hint}
          </span>
        )}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        required={required}
        className="h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none focus:shadow-[0_0_0_3px_rgba(136,192,87,0.20)] text-sm text-fg-primary placeholder:text-fg-muted disabled:opacity-50 transition-all"
      />
    </label>
  )
}
