import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Lock, User as UserIcon, LogIn, ArrowRight } from 'lucide-react'
import { AnimatedBackground } from '@/components/auth/AnimatedBackground'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useAuthStore } from '@/stores/auth.store'

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, loginGuest, error, status, clearError } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    clearError()
    const ok = await login(username.trim(), password)
    if (ok) navigate('/', { replace: true })
  }

  async function handleGuest() {
    clearError()
    const ok = await loginGuest()
    if (ok) navigate('/', { replace: true })
  }

  const loading = status === 'authenticating'

  return (
    <div className="relative w-full h-screen flex items-center justify-center overflow-hidden">
      <AnimatedBackground />

      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-md mx-6"
      >
        <div className="glass-strong rounded-xl p-10 shadow-lift">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.35 }}
            className="flex flex-col items-center mb-8"
          >
            <div className="w-14 h-14 rounded-xl bg-accent-gradient flex items-center justify-center shadow-glow mb-4">
              <LogIn className="w-7 h-7 text-white" />
            </div>
            <h1 className="font-display font-bold text-3xl text-fg-primary text-center">
              <span className="text-gradient">Nexus</span> Launcher
            </h1>
            <p className="text-sm text-fg-secondary mt-2">Bon retour. Connecte-toi pour continuer.</p>
          </motion.div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              type="text"
              label="Nom d'utilisateur ou email"
              autoComplete="username"
              leftIcon={<UserIcon className="w-4 h-4" />}
              placeholder="nexus_user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <Input
              type="password"
              label="Mot de passe"
              autoComplete="current-password"
              leftIcon={<Lock className="w-4 h-4" />}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <div className="flex items-center justify-end">
              <Link to="/forgot" className="text-xs text-fg-secondary hover:text-accent-primary transition-colors">
                Mot de passe oublié ?
              </Link>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2"
              >
                {error}
              </motion.div>
            )}

            <Button type="submit" size="lg" fullWidth loading={loading} rightIcon={<ArrowRight className="w-4 h-4" />}>
              Se connecter
            </Button>
          </form>

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-glass-border" />
            <span className="text-xs text-fg-muted uppercase tracking-wider">ou</span>
            <div className="flex-1 h-px bg-glass-border" />
          </div>

          <Button variant="secondary" size="lg" fullWidth onClick={handleGuest} disabled={loading}>
            Continuer en invité
          </Button>

          <p className="text-center text-sm text-fg-secondary mt-6">
            Pas encore de compte ?{' '}
            <Link to="/register" className="text-accent-primary hover:underline font-medium">
              En créer un
            </Link>
          </p>
        </div>

        <p className="text-center text-xs text-fg-muted mt-4">v0.1.0 · plugin-neutre · hors-ligne</p>
      </motion.div>
    </div>
  )
}
