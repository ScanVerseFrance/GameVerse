import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { KeyRound, ArrowLeft, Copy, Check } from 'lucide-react'
import { AnimatedBackground } from '@/components/auth/AnimatedBackground'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

type Step = 'request' | 'reset' | 'done'

export default function ForgotPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('request')
  const [identifier, setIdentifier] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [issuedCode, setIssuedCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleRequest(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await window.nexus.auth.requestRecoveryCode(identifier.trim())
    setBusy(false)
    if (res.ok && res.code) {
      setIssuedCode(res.code)
      setRecoveryCode(res.code)
      setStep('reset')
    } else {
      setError(res.error ?? 'Impossible de générer le code de récupération')
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault()
    if (newPassword.length < 6) {
      setError('Le mot de passe doit faire au moins 6 caractères')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas')
      return
    }
    setBusy(true)
    setError(null)
    const res = await window.nexus.auth.consumeRecoveryCode(recoveryCode.trim(), newPassword)
    setBusy(false)
    if (res.ok) setStep('done')
    else setError(res.error ?? 'Échec de la réinitialisation')
  }

  function copyCode() {
    void navigator.clipboard.writeText(issuedCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

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
            className="flex flex-col items-center mb-7"
          >
            <div className="w-12 h-12 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mb-3">
              <KeyRound className="w-6 h-6 text-accent-primary" />
            </div>
            <h1 className="font-display font-bold text-2xl text-fg-primary text-center">
              {step === 'done' ? 'Mot de passe réinitialisé' : 'Récupérer l\'accès'}
            </h1>
            <p className="text-sm text-fg-secondary mt-1.5 text-center">
              {step === 'request' && 'Entre ton nom d\'utilisateur ou email — un code de récupération sera généré localement.'}
              {step === 'reset' && 'Ton code unique est affiché ci-dessous. Utilise-le dans les 15 minutes.'}
              {step === 'done' && 'Tu peux te connecter avec ton nouveau mot de passe.'}
            </p>
          </motion.div>

          {step === 'request' && (
            <form onSubmit={handleRequest} className="flex flex-col gap-4">
              <Input
                label="Nom d'utilisateur ou email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="nexus_user ou toi@exemple.com"
                required
              />
              {error && (
                <div className="text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2">{error}</div>
              )}
              <Button type="submit" size="lg" fullWidth loading={busy}>
                Générer un code de récupération
              </Button>
            </form>
          )}

          {step === 'reset' && (
            <div className="flex flex-col gap-5">
              <div className="rounded-md bg-accent-primary/10 border border-accent-primary/30 px-4 py-4">
                <span className="text-xs text-fg-secondary uppercase tracking-wider">Ton code unique</span>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="font-mono text-2xl font-bold text-accent-primary tracking-widest">{issuedCode}</span>
                  <button
                    onClick={copyCode}
                    type="button"
                    className="p-2 rounded-sm hover:bg-white/[0.06] text-fg-secondary hover:text-accent-primary transition-colors"
                  >
                    {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-fg-muted mt-2">Colle ce code ci-dessous pour confirmer la réinitialisation.</p>
              </div>

              <form onSubmit={handleReset} className="flex flex-col gap-3">
                <Input
                  label="Code de récupération"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                  placeholder="ABCD12"
                  required
                />
                <Input
                  type="password"
                  label="Nouveau mot de passe"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
                <Input
                  type="password"
                  label="Confirmer le nouveau mot de passe"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                {error && (
                  <div className="text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2">{error}</div>
                )}
                <Button type="submit" size="lg" fullWidth loading={busy}>
                  Réinitialiser le mot de passe
                </Button>
              </form>
            </div>
          )}

          {step === 'done' && (
            <Button size="lg" fullWidth onClick={() => navigate('/login', { replace: true })}>
              Retour à la connexion
            </Button>
          )}

          <Link
            to="/login"
            className="flex items-center justify-center gap-1.5 mt-6 text-sm text-fg-secondary hover:text-accent-primary transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Retour à la connexion
          </Link>
        </div>
      </motion.div>
    </div>
  )
}
