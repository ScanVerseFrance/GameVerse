import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cloud,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  UserPlus,
  LogIn,
} from 'lucide-react'
import { useCloudStore } from '@/stores/cloud.store'
import { cn } from '@/utils/cn'

/**
 * Login / register dialog for Nexus Cloud. Two-tab UX (login default;
 * "Pas encore de compte ?" switches to register). Same modal handles
 * both flows because the field set overlaps almost entirely.
 *
 * Auto-closes 800ms after a successful auth so the user sees the
 * green check before being dropped back into the app.
 */
export function CloudConnectDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const login = useCloudStore((s) => s.login)
  const register = useCloudStore((s) => s.register)
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  function reset() {
    setUsername('')
    setPassword('')
    setEmail('')
    setDisplayName('')
    setError(null)
    setSuccess(false)
    setBusy(false)
  }

  async function handleSubmit() {
    setBusy(true)
    setError(null)
    const res =
      tab === 'login'
        ? await login(username.trim(), password)
        : await register({
            username: username.trim(),
            password,
            email: email.trim() || undefined,
            displayName: displayName.trim() || undefined,
          })
    setBusy(false)
    if (res.ok) {
      setSuccess(true)
      setTimeout(() => {
        onClose()
        reset()
      }, 800)
    } else {
      setError(res.error)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="w-full max-w-md rounded-xl bg-bg-secondary border border-glass-border shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-5 border-b border-border-soft flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center">
                <Cloud className="w-5 h-5 text-accent-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-display font-bold text-lg text-fg-primary leading-tight">
                  Nexus Cloud
                </h2>
                <p className="text-xs text-fg-muted">
                  {tab === 'login'
                    ? 'Connecte-toi pour activer amis, chat et sauvegardes cloud.'
                    : 'Crée ton compte cloud — gratuit, 2 Go de saves inclus.'}
                </p>
              </div>
              <button
                onClick={onClose}
                className="text-fg-muted hover:text-fg-primary p-1 rounded-sm hover:bg-[var(--surface-soft)]"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="px-6 pt-4">
              <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-[var(--surface-soft)] border border-glass-border">
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
              </div>
            </div>

            {/* Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!busy && !success) void handleSubmit()
              }}
              className="px-6 py-5 flex flex-col gap-3"
            >
              <Field
                label="Nom d'utilisateur"
                value={username}
                onChange={setUsername}
                placeholder="ton-pseudo"
                autoComplete="username"
                disabled={busy || success}
                required
              />
              <Field
                label="Mot de passe"
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                type="password"
                autoComplete={
                  tab === 'login' ? 'current-password' : 'new-password'
                }
                disabled={busy || success}
                required
              />
              {tab === 'register' && (
                <>
                  <Field
                    label="E-mail (optionnel)"
                    value={email}
                    onChange={setEmail}
                    placeholder="ton-email@scanverse.fr"
                    type="email"
                    autoComplete="email"
                    disabled={busy || success}
                  />
                  <Field
                    label="Nom affiché (optionnel)"
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="Ton nom"
                    disabled={busy || success}
                  />
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="flex-1">{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy || success || !username || !password}
                className="h-11 mt-1 rounded-md bg-accent-gradient text-white font-semibold text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-glow transition-shadow"
              >
                {success ? (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Connecté
                  </>
                ) : busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {tab === 'login' ? 'Connexion…' : 'Création…'}
                  </>
                ) : (
                  <>
                    <Cloud className="w-4 h-4" />
                    {tab === 'login' ? 'Se connecter' : 'Créer le compte'}
                  </>
                )}
              </button>

              <p className="text-[11px] text-fg-muted text-center mt-1">
                {tab === 'login' ? (
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
                ) : (
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
                )}
              </p>

              <p className="text-[10px] text-fg-muted text-center mt-2 leading-relaxed">
                Le mode hors-ligne reste toujours disponible — tu peux fermer
                cette fenêtre sans te connecter et continuer à jouer.
              </p>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  disabled,
  required,
}: {
  label: string
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
      <span className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
        {label}
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
