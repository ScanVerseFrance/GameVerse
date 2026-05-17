import { useState, type FormEvent, type ChangeEvent, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Lock, User as UserIcon, ArrowRight, Image as ImageIcon, X, Check } from 'lucide-react'
import { AnimatedBackground } from '@/components/auth/AnimatedBackground'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useAuthStore } from '@/stores/auth.store'

const AVATAR_MAX_BYTES = 250_000

export default function RegisterPage() {
  const navigate = useNavigate()
  const { register, error, status, clearError, updateProfile } = useAuthStore()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)

  const validity = useMemo(() => {
    const v: Record<string, string | null> = { username: null, email: null, password: null, confirm: null }
    if (username && (username.length < 3 || username.length > 32)) v.username = '3 à 32 caractères'
    if (username && !/^[a-zA-Z0-9_.-]+$/.test(username)) v.username = 'lettres, chiffres, _ . - uniquement'
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) v.email = 'email invalide'
    if (password && password.length < 6) v.password = '6 caractères minimum'
    if (confirm && password !== confirm) v.confirm = 'les mots de passe ne correspondent pas'
    return v
  }, [username, email, password, confirm])

  const canSubmit =
    username.length >= 3 &&
    password.length >= 6 &&
    password === confirm &&
    !validity.username &&
    !validity.email &&
    !validity.password

  function handleAvatar(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > AVATAR_MAX_BYTES) {
      setAvatarError(`L'avatar doit faire moins de ${Math.round(AVATAR_MAX_BYTES / 1024)} Ko`)
      return
    }
    setAvatarError(null)
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setAvatarDataUrl(reader.result)
    }
    reader.readAsDataURL(f)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    clearError()
    const ok = await register({
      username: username.trim(),
      email: email.trim() || undefined,
      password,
      displayName: displayName.trim() || undefined,
    })
    if (ok) {
      if (avatarDataUrl) await updateProfile({ avatarPath: avatarDataUrl })
      navigate('/', { replace: true })
    }
  }

  const loading = status === 'authenticating'

  return (
    <div className="relative w-full h-screen flex items-center justify-center overflow-hidden">
      <AnimatedBackground />

      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-md mx-6 my-8"
      >
        <div className="glass-strong rounded-xl p-8 shadow-lift">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.35 }}
            className="flex flex-col items-center mb-6"
          >
            <h1 className="font-display font-bold text-2xl text-fg-primary text-center">
              Rejoindre <span className="text-gradient">Nexus</span>
            </h1>
            <p className="text-sm text-fg-secondary mt-1.5">Crée ton compte en quelques secondes</p>
          </motion.div>

          <div className="flex flex-col items-center mb-5">
            <label className="relative cursor-pointer group">
              <div className="w-20 h-20 rounded-full bg-bg-tertiary border-2 border-glass-border overflow-hidden flex items-center justify-center group-hover:border-accent-primary/60 transition-colors">
                {avatarDataUrl ? (
                  <img src={avatarDataUrl} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="w-7 h-7 text-fg-muted" />
                )}
              </div>
              {avatarDataUrl && (
                <button
                  type="button"
                  className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-error text-white flex items-center justify-center"
                  onClick={(e) => {
                    e.preventDefault()
                    setAvatarDataUrl(null)
                  }}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
              <input type="file" accept="image/*" className="hidden" onChange={handleAvatar} />
            </label>
            <span className="text-xs text-fg-muted mt-2">
              {avatarDataUrl ? 'Clique sur X pour retirer' : 'Clique pour ajouter un avatar (optionnel)'}
            </span>
            {avatarError && <span className="text-xs text-error mt-1">{avatarError}</span>}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              label="Nom d'utilisateur"
              leftIcon={<UserIcon className="w-4 h-4" />}
              placeholder="nexus_user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              errorText={validity.username ?? undefined}
              autoComplete="username"
              required
            />
            <Input
              type="email"
              label="Email (optionnel)"
              leftIcon={<Mail className="w-4 h-4" />}
              placeholder="toi@exemple.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              errorText={validity.email ?? undefined}
              helpText="Utilisé pour la récupération de mot de passe"
              autoComplete="email"
            />
            <Input
              label="Nom affiché (optionnel)"
              placeholder="Ton nom"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
            <Input
              type="password"
              label="Mot de passe"
              leftIcon={<Lock className="w-4 h-4" />}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              errorText={validity.password ?? undefined}
              autoComplete="new-password"
              required
            />
            <Input
              type="password"
              label="Confirmer le mot de passe"
              leftIcon={<Lock className="w-4 h-4" />}
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              errorText={validity.confirm ?? undefined}
              rightSlot={confirm && password === confirm ? <Check className="w-4 h-4 text-success" /> : undefined}
              autoComplete="new-password"
              required
            />

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2"
              >
                {error}
              </motion.div>
            )}

            <Button
              type="submit"
              size="lg"
              fullWidth
              loading={loading}
              disabled={!canSubmit}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Créer le compte
            </Button>
          </form>

          <p className="text-center text-sm text-fg-secondary mt-5">
            Déjà un compte ?{' '}
            <Link to="/login" className="text-accent-primary hover:underline font-medium">
              Se connecter
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  )
}
