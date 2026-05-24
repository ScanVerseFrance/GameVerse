import { useState } from 'react'
import { Globe, CheckCircle2, AlertCircle, ArrowRight } from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useAddonStore } from '@/stores/addon.store'

interface InstallAddonDialogProps {
  open: boolean
  onClose: () => void
}

export function InstallAddonDialog({ open, onClose }: InstallAddonDialogProps) {
  const install = useAddonStore((s) => s.install)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  function reset() {
    setUrl('')
    setError(null)
    setSuccess(null)
    setBusy(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleInstall() {
    if (!url.trim()) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    const res = await install(url.trim())
    setBusy(false)
    if (res.ok) {
      setSuccess(`${res.addon.name} v${res.addon.version} installé`)
      setUrl('')
      setTimeout(handleClose, 1200)
    } else {
      setError(res.error)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Installer un addon"
      description="Colle l'URL du manifeste d'un addon. Nexus le récupère et le valide."
      maxWidth="lg"
    >
      <div className="flex flex-col gap-5">
        <Input
          label="URL du manifeste"
          leftIcon={<Globe className="w-4 h-4" />}
          placeholder="https://addon.example.com/manifest.json"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
        />

        {error && (
          <div className="flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1 break-words">{error}</span>
          </div>
        )}

        {success && (
          <div className="flex items-start gap-2 text-sm text-success bg-success/10 border border-success/20 rounded-sm px-3 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1">{success}</span>
          </div>
        )}

        <div className="text-xs text-fg-muted leading-relaxed">
          <p className="mb-2">Un manifeste valide est un document JSON avec au minimum :</p>
          <pre className="font-mono text-[11px] bg-[var(--surface-soft)] border border-glass-border rounded-sm px-3 py-2 overflow-x-auto whitespace-pre">
{`{
  "id": "com.example.addon",
  "name": "Exemple",
  "version": "1.0.0",
  "contentType": "games",
  "endpoints": { "catalog": "/catalog" },
  "catalogs": [{ "id": "all", "name": "Tous les jeux" }]
}`}
          </pre>
          <p className="mt-2">
            Endpoints optionnels : <code className="font-mono">meta</code> (détail d'un jeu),{' '}
            <code className="font-mono">download</code> (sources), <code className="font-mono">search</code>,{' '}
            <code className="font-mono">featured</code>. Utilise <code className="font-mono">:id</code> dans les chemins
            pour binder l'ID du jeu demandé.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleClose} disabled={busy}>
            Annuler
          </Button>
          <Button
            onClick={handleInstall}
            loading={busy}
            disabled={!url.trim()}
            rightIcon={<ArrowRight className="w-4 h-4" />}
          >
            Installer
          </Button>
        </div>
      </div>
    </Modal>
  )
}
