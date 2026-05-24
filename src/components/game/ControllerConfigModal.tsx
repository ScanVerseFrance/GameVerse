/**
 * Configurateur "Nexus Input" — accessible via le bouton 🎮 sur la
 * fiche d'un jeu. Mirror 1:1 de l'UI Nexus Input :
 *   - Main view    : toggle bypass + résumé + 2 boutons d'accès
 *   - Preview view : layout visuel manette (PS / Xbox) avec mappings
 *   - Edit view    : sidebar catégories + panel détail
 *
 * Phase 1 : tout est UI + persistance JSON. L'injection ViGEm
 * (Phase 2) consommera la même config sans changement de schéma.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Gamepad2,
  Save,
  RotateCcw,
  AlertTriangle,
  Check,
  Eye,
  Settings as SettingsIcon,
  ChevronRight,
  ChevronLeft,
  HelpCircle,
  Move,
  Crosshair,
  CircleDot,
  Layers,
} from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/stores/auth.store'
import { toast } from '@/stores/inAppToast.store'
import {
  type ControllerConfig,
  type VirtualButton,
  VIRTUAL_BUTTONS,
  BUTTON_LABEL,
  defaultControllerConfig,
  detectVendor,
  shortControllerName,
} from '@/types/controller.types'
import { cn } from '@/utils/cn'

interface Props {
  open: boolean
  libraryGameId: string
  gameTitle: string
  onClose: () => void
}

type View = 'main' | 'preview' | 'edit'
type EditCategory =
  | 'buttons'
  | 'dpad'
  | 'triggers'
  | 'joysticks'
  | 'trackpads'
  | 'gyro'

interface DetectedPad {
  id: string
  index: number
  vendor: ReturnType<typeof detectVendor>
  shortName: string
}

export function ControllerConfigModal({
  open,
  libraryGameId,
  gameTitle,
  onClose,
}: Props) {
  const user = useAuthStore((s) => s.user)
  const [config, setConfig] = useState<ControllerConfig>(defaultControllerConfig)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pads, setPads] = useState<DetectedPad[]>([])
  const [view, setView] = useState<View>('main')
  const [editCategory, setEditCategory] = useState<EditCategory>('buttons')
  // Bridge runtime state — vrai status du helper C# côté main,
  // synced via `bridgeStatus` au mount + `onBridgeEvent` ensuite.
  const [bridgeRunning, setBridgeRunning] = useState(false)
  const [bridgePadName, setBridgePadName] = useState<string | null>(null)

  // ── Load config from DB ─────────────────────────────────────────
  useEffect(() => {
    if (!open || !user) return
    let cancelled = false
    setLoading(true)
    setView('main')
    void window.nexus.controller
      .getConfig(user.id, libraryGameId)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setConfig(res.config)
        else setConfig(defaultControllerConfig())
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, user, libraryGameId])

  // ── Live controller detection ───────────────────────────────────
  useEffect(() => {
    if (!open) return
    function refresh() {
      // 1) Raw enumeration via Gamepad API.
      const raw: DetectedPad[] = []
      const gp = navigator.getGamepads?.() ?? []
      for (const p of gp) {
        if (!p) continue
        // Skip audio devices misdetected comme gamepad. Certains
        // casques (HyperX Cloud III, Logitech G733, etc.) exposent
        // un petit HID endpoint pour les boutons mute/vol qui
        // remonte dans la Gamepad API. On filtre par mots-clés
        // dans le nom — les vraies manettes n'ont jamais
        // "headset/cloud/audio/headphone" dans leur id.
        if (
          /headset|cloud|audio|headphone|stinger|spectre|wireless audio|casque/i.test(
            p.id,
          )
        ) {
          continue
        }
        raw.push({
          id: p.id,
          index: p.index,
          vendor: detectVendor(p.id),
          shortName: shortControllerName(p.id),
        })
      }
      // 2) Dédup virtual-pad-vs-real-pad.
      // Cas typique : l'user a une DualSense + DS4Windows ouvert.
      // Windows expose alors DEUX gamepads :
      //   - "DualSense Wireless Controller (Vendor: 054c Product: 0ce6)"
      //     → la vraie manette physique, AVEC vendor/product IDs
      //   - "PS5 Controller" (sans Vendor: dans la string)
      //     → le pad virtuel émis par DS4Windows / ViGEm pour exposer
      //       la DualSense au format XInput compatible jeux
      // Steam Input fusionne ces deux en UN seul slot ; on fait pareil
      // pour pas confondre l'user. Règle : pour chaque vendor, on
      // garde la première entrée qui a un "Vendor: XXXX Product: XXXX"
      // dans son id (= hardware réel détecté par Windows), et on
      // squash les entrées sans IDs qui partagent le même vendor.
      const list: DetectedPad[] = []
      const realByVendor = new Set<typeof raw[number]['vendor']>()
      // 1ère passe : on identifie les "vrais" hardware par vendor
      for (const p of raw) {
        if (/Vendor:\s*[0-9a-f]+/i.test(p.id)) {
          if (!realByVendor.has(p.vendor)) {
            realByVendor.add(p.vendor)
            list.push(p)
          }
        }
      }
      // 2ème passe : on ajoute les pads sans Vendor: id UNIQUEMENT si
      // aucun vrai hardware du même vendor n'a déjà été ajouté
      // (sinon on suppose que c'est un mirror virtuel DS4Windows /
      // ViGEm de la manette déjà listée).
      for (const p of raw) {
        if (/Vendor:\s*[0-9a-f]+/i.test(p.id)) continue
        if (realByVendor.has(p.vendor)) continue
        list.push(p)
      }
      setPads(list)
    }
    refresh()
    const onConn = () => refresh()
    const onDisc = () => refresh()
    window.addEventListener('gamepadconnected', onConn)
    window.addEventListener('gamepaddisconnected', onDisc)
    const iv = window.setInterval(refresh, 2000)
    return () => {
      window.removeEventListener('gamepadconnected', onConn)
      window.removeEventListener('gamepaddisconnected', onDisc)
      window.clearInterval(iv)
    }
  }, [open])

  // ── Bridge events from C# helper ───────────────────────────────
  // Le helper émet "connected" (manette bridged), "error" (ViGEm absent,
  // HID busy), "disconnected" (pad débranché), "exited" (process killed),
  // "driverInstalled" (ViGEmBus a été auto-installé via UAC). On surface
  // via toasts + maintient les états bridgeRunning / bridgePadName pour
  // le badge live dans la modal.
  useEffect(() => {
    if (!open) return
    // Sync initial status (en cas où le bridge tourne déjà parce que
    // l'user a activé Nexus Input depuis un autre jeu).
    void window.nexus.controller.bridgeStatus().then((res) => {
      if (res.ok) setBridgeRunning(res.running)
    })
    const off = window.nexus.controller.onBridgeEvent((payload) => {
      const evt = payload.event as string
      if (evt === 'connected') {
        const name = (payload.name as string) ?? 'manette'
        setBridgeRunning(true)
        setBridgePadName(name)
        toast.success(`Nexus Input actif sur ${name}`)
      } else if (evt === 'disconnected') {
        setBridgeRunning(false)
        setBridgePadName(null)
        toast.info('Manette débranchée')
      } else if (evt === 'exited') {
        setBridgeRunning(false)
        setBridgePadName(null)
      } else if (evt === 'driverInstalled') {
        toast.info('Driver ViGEmBus installé — Nexus Input prêt')
      } else if (evt === 'error') {
        const code = payload.code as string
        const msg = (payload.msg as string) ?? 'Erreur Nexus Input'
        setBridgeRunning(false)
        if (code === 'VIGEM_MISSING') {
          toast.error(
            "Driver ViGEmBus introuvable. Installation automatique impossible — installe manuellement depuis github.com/nefarius/ViGEmBus/releases.",
          )
        } else if (code === 'HID_BUSY') {
          toast.error(
            'La manette est utilisée par une autre app (Steam / DS4Windows). Ferme-la et réessaye.',
          )
        } else if (code === 'NO_PAD') {
          toast.error('Aucune manette PlayStation détectée. Branche-en une et réessaye.')
        } else {
          toast.error(msg)
        }
      }
    })
    return () => off()
  }, [open])

  // ── Save handlers ───────────────────────────────────────────────
  async function handleSave() {
    if (!user) return
    setSaving(true)
    try {
      const res = await window.nexus.controller.setConfig(
        user.id,
        libraryGameId,
        config,
      )
      if (res.ok) {
        // Push la config fraîche au helper si le bridge tourne.
        // Sans ça l'user devait redémarrer le bridge pour voir ses
        // nouveaux remap / deadzones / gyro pris en compte.
        void window.nexus.controller.pushBridgeConfig(config)
        toast.success('Configuration manette sauvegardée')
        onClose()
      } else {
        toast.error(`Échec sauvegarde : ${res.error}`)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    if (!user) return
    if (!confirm('Réinitialiser au profil par défaut ?')) return
    await window.nexus.controller.deleteConfig(user.id, libraryGameId)
    setConfig(defaultControllerConfig())
    toast.info('Profil manette réinitialisé')
  }

  function setRemap(from: VirtualButton, to: VirtualButton | '') {
    setConfig((c) => {
      const next = { ...c.remap }
      if (!to || from === to) delete next[from]
      else next[from] = to
      return { ...c, remap: next }
    })
  }

  function togglePad(id: string) {
    setConfig((c) => {
      const has = c.selectedControllers.includes(id)
      return {
        ...c,
        selectedControllers: has
          ? c.selectedControllers.filter((x) => x !== id)
          : [...c.selectedControllers, id],
      }
    })
  }

  // ── Header with breadcrumb ──────────────────────────────────────
  const title = useMemo(() => {
    if (view === 'main') return `Paramètres de la manette pour ${gameTitle}`
    if (view === 'preview') return `Aperçu — ${gameTitle}`
    return `Modifier la configuration — ${gameTitle}`
  }, [view, gameTitle])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth="4xl"
    >
      {loading ? (
        <div className="py-10 text-center text-sm text-fg-muted">
          Chargement de la configuration…
        </div>
      ) : (
        <div className="flex flex-col gap-4 min-h-[500px]">
          {/* Back-button breadcrumb when in a sub-view */}
          {view !== 'main' && (
            <button
              onClick={() => setView('main')}
              className="self-start inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent-primary transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Retour aux paramètres
            </button>
          )}

          {view === 'main' && (
            <MainView
              config={config}
              setConfig={setConfig}
              pads={pads}
              bridgeRunning={bridgeRunning}
              bridgePadName={bridgePadName}
              onTogglePad={togglePad}
              onOpenPreview={() => setView('preview')}
              onOpenEdit={() => {
                setEditCategory('buttons')
                setView('edit')
              }}
            />
          )}

          {view === 'preview' && (
            <PreviewView config={config} pads={pads} gameTitle={gameTitle} />
          )}

          {view === 'edit' && (
            <EditView
              config={config}
              setConfig={setConfig}
              category={editCategory}
              setCategory={setEditCategory}
              onRemap={setRemap}
              vendor={pads[0]?.vendor ?? 'xbox'}
            />
          )}

          {/* ── Footer actions — same across all views ──────────── */}
          <div className="flex justify-between gap-2 pt-3 border-t border-glass-border">
            <Button variant="outline" onClick={handleReset} disabled={saving}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Réinitialiser
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Annuler
              </Button>
              <Button onClick={() => void handleSave()} loading={saving}>
                <Save className="w-4 h-4 mr-1.5" /> Sauvegarder
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ─────────────────────────────────────────────────────────────────
   MAIN VIEW — résumé + quick settings + accès aux sous-vues
   Mirror exact de l'écran "Paramètres du contrôleur" de Steam.
   ───────────────────────────────────────────────────────────── */
function MainView({
  config,
  setConfig,
  pads,
  bridgeRunning,
  bridgePadName,
  onTogglePad,
  onOpenPreview,
  onOpenEdit,
}: {
  config: ControllerConfig
  setConfig: React.Dispatch<React.SetStateAction<ControllerConfig>>
  pads: DetectedPad[]
  bridgeRunning: boolean
  bridgePadName: string | null
  onTogglePad: (id: string) => void
  onOpenPreview: () => void
  onOpenEdit: () => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Header : toggle Nexus Input + description */}
      <section className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <p className="text-sm font-semibold text-fg-primary">
              Utilise une couche de compatibilité Nexus Input
            </p>
            {/* Live status badge — dot vert pulsé quand le helper
                tourne + bridge la manette. Indique à l'user que le
                virtual Xbox pad est ACTIF et que le jeu reçoit les
                inputs via Nexus. */}
            {bridgeRunning && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/15 border border-green-500/40 text-[10px] font-bold text-green-400 uppercase tracking-wider shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                {bridgePadName ? `Actif · ${bridgePadName.split(' ')[0]}` : 'Actif'}
              </span>
            )}
          </div>
          <button
            onClick={() => {
              const next = !config.enabled
              setConfig({ ...config, enabled: next })
              // Phase 2 : démarre / arrête le helper C# en même temps
              // que le toggle UI. Les events arrivent ensuite via
              // onBridgeEvent (cf. useEffect plus bas) et populent
              // toasts succès / erreur (driver ViGEm manquant, etc.).
              if (next) {
                void window.nexus.controller.startBridge().then((res) => {
                  if (!res.ok) {
                    toast.error(res.error ?? 'Échec démarrage Nexus Input')
                    return
                  }
                  // Push la config courante au helper dès le start
                  // pour que remap / deadzones / gyro soient pris en
                  // compte sans attendre un save explicite.
                  void window.nexus.controller.pushBridgeConfig({
                    ...config,
                    enabled: true,
                  })
                })
              } else {
                void window.nexus.controller.stopBridge()
              }
            }}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-semibold border transition-colors shrink-0',
              config.enabled
                ? 'bg-error/10 border-error/30 text-error hover:bg-error/20'
                : 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary hover:bg-accent-primary/20',
            )}
          >
            {config.enabled ? 'Désactiver Nexus Input' : 'Activer Nexus Input'}
          </button>
        </div>
        <p className="text-xs text-fg-muted mt-2">
          Ce jeu prend entièrement en charge certains contrôleurs, mais
          pas le vôtre. Nexus Input est utilisé pour convertir les entrées
          de votre contrôleur.
        </p>
      </section>

      {/* Info contrôleurs */}
      <section>
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-secondary mb-1">
          Information sur la prise en charge de contrôleurs
        </p>
        <p className="text-[11px] text-fg-muted">
          Ce raccourci ne dispose d'aucune information sur la prise en
          charge de contrôleurs.
        </p>
      </section>

      {/* Manettes branchées + sélection */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-secondary">
            Manettes détectées · {pads.length}
          </p>
          <HelpCircle className="w-4 h-4 text-fg-muted" />
        </div>
        {pads.length === 0 ? (
          <div className="rounded-md border border-dashed border-glass-border p-4 text-center text-xs text-fg-muted">
            <AlertTriangle className="w-4 h-4 inline mr-1 -mt-0.5" />
            Aucune manette branchée. Branche / réveille ta manette (appuie
            sur un bouton) et elle apparaîtra ici.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pads.map((p) => {
              const selected = config.selectedControllers.includes(p.id)
              return (
                <li
                  key={p.id + p.index}
                  className={cn(
                    'flex items-center gap-3 p-2.5 rounded-md border bg-[var(--surface-soft)] cursor-pointer transition-colors',
                    selected
                      ? 'border-accent-primary/40 hover:border-accent-primary'
                      : 'border-glass-border hover:border-accent-primary/20',
                  )}
                  onClick={() => onTogglePad(p.id)}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onTogglePad(p.id)}
                    className="accent-accent-primary w-4 h-4 pointer-events-none"
                  />
                  <VendorBadge vendor={p.vendor} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-fg-primary truncate">
                      {p.shortName}
                    </p>
                    <p className="text-[10px] font-mono text-fg-faint truncate">
                      slot {p.index}
                    </p>
                  </div>
                  {selected && <Check className="w-4 h-4 text-accent-primary" />}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Configuration actuelle des boutons */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-secondary">
            Configuration actuelle des boutons
          </p>
          <HelpCircle className="w-4 h-4 text-fg-muted" />
        </div>
        <button
          onClick={onOpenPreview}
          className="w-full flex items-center gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 transition-colors"
        >
          <div className="w-8 h-6 rounded bg-bg-secondary border border-glass-border flex items-center justify-center">
            <Gamepad2 className="w-4 h-4 text-fg-secondary" />
          </div>
          <span className="text-sm font-semibold text-fg-primary flex-1 text-left">
            Manette
          </span>
          <ChevronRight className="w-4 h-4 text-fg-muted" />
        </button>
        <p className="text-[11px] text-fg-muted mt-1.5">
          Explorez les{' '}
          <span className="text-accent-primary">configurations</span> pour les
          jeux qui ne prennent pas officiellement en charge les contrôleurs.
        </p>
      </section>

      {/* Boutons d'accès */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onOpenPreview}
          className="h-10 rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/30 text-sm font-semibold text-fg-primary inline-flex items-center justify-center gap-2"
        >
          <Eye className="w-4 h-4" /> Voir la configuration
        </button>
        <button
          onClick={onOpenEdit}
          className="h-10 rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/30 text-sm font-semibold text-fg-primary inline-flex items-center justify-center gap-2"
        >
          <SettingsIcon className="w-4 h-4" /> Modifier la configuration
        </button>
      </div>

      {/* Réglages rapides — gyro + invert Y + rumble */}
      <section>
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-secondary mb-3">
          Réglages rapides
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg-secondary">
              Gyroscope : comportement
            </span>
            <select
              value={config.gyro.enabled ? config.gyro.mode : 'none'}
              onChange={(e) => {
                const v = e.target.value
                setConfig({
                  ...config,
                  gyro: {
                    ...config.gyro,
                    enabled: v !== 'none',
                    mode: v === 'mouse' ? 'mouse' : 'rightStick',
                  },
                })
              }}
              className="h-8 px-2 rounded bg-bg-secondary border border-glass-border text-sm text-fg-primary min-w-[180px]"
            >
              <option value="none">Aucun</option>
              <option value="rightStick">Joystick droit</option>
              <option value="mouse">Souris</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg-secondary">
              Type de manette virtuelle
            </span>
            <select
              value={config.targetType}
              onChange={(e) =>
                setConfig({
                  ...config,
                  targetType: e.target.value as 'xbox360' | 'ds4',
                })
              }
              className="h-8 px-2 rounded bg-bg-secondary border border-glass-border text-sm text-fg-primary min-w-[180px]"
            >
              <option value="xbox360">Xbox 360 (XInput)</option>
              <option value="ds4">DualShock 4</option>
            </select>
          </div>
          <ToggleRow
            label="Inverser l'axe des y du joystick droit"
            value={config.invertY}
            onChange={(v) => setConfig({ ...config, invertY: v })}
          />
          <ToggleRow
            label="Vibration (rumble) du jeu vers la manette"
            value={config.rumbleEnabled}
            onChange={(v) => setConfig({ ...config, rumbleEnabled: v })}
          />
        </div>
      </section>

      {/* Phase 2 status note + hint Gamepad API */}
      <p className="text-[11px] text-fg-faint italic leading-relaxed">
        <strong>💡 Astuce :</strong> Windows ne révèle les manettes branchées
        qu'après que tu aies <strong>appuyé sur un bouton</strong> (sécurité
        Chromium / Gamepad API). Si la liste reste vide, presse n'importe
        quel bouton de ta manette pour qu'elle apparaisse.
      </p>
      <p className="text-[11px] text-fg-faint leading-relaxed">
        Nexus Input v0.4.3 bridge la manette physique → virtual Xbox 360 pad
        via ViGEmBus. Le driver est installé automatiquement à la 1ère
        activation. Limitations connues : pas encore de HidHide (rare jeux
        qui scrutent Windows.Gaming.Input voient encore les 2 pads),
        pas de touchpad, pas de chord.
      </p>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   PREVIEW VIEW — layout visuel avec mappings autour d'une manette
   stylisée. Adapté pour XBOX et PS selon la 1ère manette détectée.
   ───────────────────────────────────────────────────────────── */
function PreviewView({
  config,
  pads,
  gameTitle,
}: {
  config: ControllerConfig
  pads: DetectedPad[]
  gameTitle: string
}) {
  const primaryVendor = pads[0]?.vendor ?? 'xbox'
  const isPS = primaryVendor === 'playstation'
  // Mappings affichés : préfère le remap user → tomber sur défaut.
  function display(btn: VirtualButton): string {
    const remapped = config.remap[btn]
    return remapped ? BUTTON_LABEL[remapped] : BUTTON_LABEL[btn]
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Titre Steam-style "CONFIGURATION OFFICIELLE POUR [JEU] : MANETTE" */}
      <p className="text-center text-sm font-bold uppercase tracking-widest text-fg-primary mb-2">
        Configuration : Manette
      </p>
      <p className="text-center text-[11px] uppercase tracking-wider text-fg-muted mb-4 truncate">
        {gameTitle}
      </p>
      {/* Layout 3 colonnes : left mappings / GROS controller visual / right mappings.
          Le grid auto place les mappings près des bumpers/triggers. */}
      <div className="grid grid-cols-[minmax(180px,1fr)_auto_minmax(180px,1fr)] gap-4 mb-6 items-center">
        {/* LEFT — bumpers/triggers/menu */}
        <div className="flex flex-col gap-4 text-right">
          <MappingRow icon="LB" vendor={primaryVendor} label="Gâchette haute gauche" mapped={display('LB')} align="right" />
          <MappingRow icon="LT" vendor={primaryVendor} label="Gâchette gauche" mapped={display('LT')} align="right" />
          <MappingRow icon="BACK" vendor={primaryVendor} label="Select" mapped={display('BACK')} align="right" />
        </div>

        {/* CENTER — gros body PNG */}
        <ControllerVisual vendor={primaryVendor} />

        {/* RIGHT — bumpers/triggers/menu */}
        <div className="flex flex-col gap-4 text-left">
          <MappingRow icon="RB" vendor={primaryVendor} label="Gâchette haute droite" mapped={display('RB')} align="left" />
          <MappingRow icon="RT" vendor={primaryVendor} label="Gâchette droite" mapped={display('RT')} align="left" />
          <MappingRow icon="START" vendor={primaryVendor} label="Start" mapped={display('START')} align="left" />
        </div>
      </div>

      {/* Bottom row : DPad / sticks / [gyro PS only] / face buttons.
          Steam ne montre la colonne Gyroscope que pour les manettes qui
          en ont (PS / Switch). Pour Xbox on saute. */}
      <div
        className={cn(
          'grid gap-4 border-t border-glass-border pt-4',
          isPS ? 'grid-cols-2 md:grid-cols-5' : 'grid-cols-2 md:grid-cols-4',
        )}
      >
        <SectionGrid title="Joystick gauche">
          <SmallRow icon={<ControllerGlyph button="LSTICK" vendor={primaryVendor} size="sm" />} label="Joystick" mapped="LSTICK axes" />
          <SmallRow icon={<ControllerGlyph button="LSTICK" vendor={primaryVendor} size="sm" />} label="Clic du stick gauche" mapped={display('LSTICK')} />
        </SectionGrid>
        <SectionGrid title="D-Pad">
          <SmallRow icon={<ControllerGlyph button="DPAD_UP" vendor={primaryVendor} size="sm" />} label="D-pad : haut" mapped={display('DPAD_UP')} />
          <SmallRow icon={<ControllerGlyph button="DPAD_DOWN" vendor={primaryVendor} size="sm" />} label="D-pad : bas" mapped={display('DPAD_DOWN')} />
          <SmallRow icon={<ControllerGlyph button="DPAD_LEFT" vendor={primaryVendor} size="sm" />} label="D-pad : gauche" mapped={display('DPAD_LEFT')} />
          <SmallRow icon={<ControllerGlyph button="DPAD_RIGHT" vendor={primaryVendor} size="sm" />} label="D-pad : droite" mapped={display('DPAD_RIGHT')} />
        </SectionGrid>
        {isPS && (
          <SectionGrid title="Gyroscope">
            <SmallRow
              label="Mode"
              mapped={
                config.gyro.enabled
                  ? config.gyro.mode === 'mouse'
                    ? 'Souris'
                    : 'Joystick droit'
                  : 'Désactivé'
              }
            />
          </SectionGrid>
        )}
        <SectionGrid title="Joystick droit">
          <SmallRow icon={<ControllerGlyph button="RSTICK" vendor={primaryVendor} size="sm" />} label="Joystick" mapped={`RSTICK axes${config.invertY ? ' (Y inv.)' : ''}`} />
          <SmallRow icon={<ControllerGlyph button="RSTICK" vendor={primaryVendor} size="sm" />} label="Clic du stick droit" mapped={display('RSTICK')} />
        </SectionGrid>
        <SectionGrid title="Boutons avant">
          <SmallRow icon={<ControllerGlyph button="A" vendor={primaryVendor} size="sm" />} label="Bouton A" mapped={display('A')} />
          <SmallRow icon={<ControllerGlyph button="B" vendor={primaryVendor} size="sm" />} label="Bouton B" mapped={display('B')} />
          <SmallRow icon={<ControllerGlyph button="X" vendor={primaryVendor} size="sm" />} label="Bouton X" mapped={display('X')} />
          <SmallRow icon={<ControllerGlyph button="Y" vendor={primaryVendor} size="sm" />} label="Bouton Y" mapped={display('Y')} />
        </SectionGrid>
      </div>
    </div>
  )
}

function MappingRow({
  icon,
  vendor,
  label,
  mapped,
  align,
}: {
  icon: VirtualButton
  vendor: ReturnType<typeof detectVendor>
  label: string
  mapped: string
  align: 'left' | 'right'
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 text-sm',
        align === 'right' ? 'justify-end' : 'justify-start',
      )}
    >
      {align === 'left' && <ControllerGlyph button={icon} vendor={vendor} size="lg" />}
      <div className={cn('flex flex-col leading-tight', align === 'right' ? 'items-end' : 'items-start')}>
        <span className="text-fg-primary font-medium">{label}</span>
        <span className="text-[11px] text-fg-muted font-mono">{mapped}</span>
      </div>
      {align === 'right' && <ControllerGlyph button={icon} vendor={vendor} size="lg" />}
    </div>
  )
}

/**
 * Glyph component — utilise les vrais assets PNG Steam scrappés dans
 * `public/controller-buttons/`. Vite les sert directement à
 * `/controller-buttons/...`. Vendor switch entre xbox/playstation
 * pour les face buttons + system buttons + triggers. Pour le D-Pad
 * et les clics sticks (pas d'asset dispo), on garde un fallback
 * stylisé.
 */
function ControllerGlyph({
  button,
  vendor,
  size = 'md',
}: {
  button: VirtualButton
  vendor: ReturnType<typeof detectVendor>
  size?: 'sm' | 'md' | 'lg'
}) {
  const src = assetForButton(button, vendor, size)
  const dim =
    size === 'sm' ? 'w-5 h-5' : size === 'lg' ? 'w-10 h-10' : 'w-7 h-7'
  if (src) {
    return (
      <img
        src={src}
        alt={BUTTON_LABEL[button] ?? button}
        title={BUTTON_LABEL[button] ?? button}
        className={cn(dim, 'object-contain shrink-0 select-none')}
        draggable={false}
        style={{ maxWidth: 'none' }}
      />
    )
  }
  // Last-resort chip (théoriquement plus jamais hit maintenant qu'on
  // a tout le catalogue Steam knockout).
  return (
    <span className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded bg-bg-secondary border border-glass-border text-[10px] font-bold font-mono text-fg-primary">
      {button}
    </span>
  )
}

/** Mapping VirtualButton + vendor → chemin asset PNG (Steam glyphs
 *  scrappés dans `public/steam-glyphs/`). null = pas d'asset dispo
 *  (rare maintenant qu'on a TOUT le catalogue Steam knockout). */
function assetForButton(
  button: VirtualButton,
  vendor: ReturnType<typeof detectVendor>,
  size: 'sm' | 'md' | 'lg',
): string | null {
  const sfx = size === 'lg' ? '_lg' : size === 'sm' ? '_sm' : '_md'
  const isPS = vendor === 'playstation'
  const base = '/steam-glyphs'
  // Face buttons — Steam utilise `shared_color_button_<a|b|x|y>` pour
  // les Xbox et `ps_color_button_<x|circle|square|triangle>` pour PS.
  if (button === 'A') {
    return isPS
      ? `${base}/ps_color_button_x${sfx}.png`
      : `${base}/shared_color_button_a${sfx}.png`
  }
  if (button === 'B') {
    return isPS
      ? `${base}/ps_color_button_circle${sfx}.png`
      : `${base}/shared_color_button_b${sfx}.png`
  }
  if (button === 'X') {
    return isPS
      ? `${base}/ps_color_button_square${sfx}.png`
      : `${base}/shared_color_button_x${sfx}.png`
  }
  if (button === 'Y') {
    return isPS
      ? `${base}/ps_color_button_triangle${sfx}.png`
      : `${base}/shared_color_button_y${sfx}.png`
  }
  // Bumpers + triggers
  if (button === 'LB') return isPS ? `${base}/ps4_l1${sfx}.png` : `${base}/xbox_lb${sfx}.png`
  if (button === 'RB') return isPS ? `${base}/ps4_r1${sfx}.png` : `${base}/xbox_rb${sfx}.png`
  if (button === 'LT') return isPS ? `${base}/ps4_l2${sfx}.png` : `${base}/xbox_lt${sfx}.png`
  if (button === 'RT') return isPS ? `${base}/ps4_r2${sfx}.png` : `${base}/xbox_rt${sfx}.png`
  // System buttons
  if (button === 'BACK') {
    return isPS
      ? `${base}/ps5_button_create${sfx}.png`
      : `${base}/xbox_button_select${sfx}.png`
  }
  if (button === 'START') {
    return isPS
      ? `${base}/ps5_button_options${sfx}.png`
      : `${base}/xbox_button_start${sfx}.png`
  }
  if (button === 'GUIDE') {
    return isPS
      ? `${base}/ps4_button_logo${sfx}.png`
      : `${base}/xbox_button_logo${sfx}.png`
  }
  // D-Pad directions — `shared_dpad_<dir>` marche pour les 2 vendors
  if (button === 'DPAD_UP') return `${base}/shared_dpad_up${sfx}.png`
  if (button === 'DPAD_DOWN') return `${base}/shared_dpad_down${sfx}.png`
  if (button === 'DPAD_LEFT') return `${base}/shared_dpad_left${sfx}.png`
  if (button === 'DPAD_RIGHT') return `${base}/shared_dpad_right${sfx}.png`
  // Stick clicks — `shared_lstick_click` / `shared_rstick_click`
  if (button === 'LSTICK') return `${base}/shared_lstick_click${sfx}.png`
  if (button === 'RSTICK') return `${base}/shared_rstick_click${sfx}.png`
  return null
}


function SectionGrid({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1.5">
        {title}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function SmallRow({
  label,
  mapped,
  icon,
}: {
  label: string
  mapped: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="text-fg-secondary truncate flex-1">{label}</span>
      <span className="text-fg-primary font-mono truncate">{mapped}</span>
    </div>
  )
}

/** Visuel manette — utilise les vraies images PNG dans
 *  `public/controller-bodies/`. Choix du body selon le vendor du
 *  premier pad détecté. PS5 par défaut pour PlayStation, Xbox One
 *  par défaut pour Xbox. */
function ControllerVisual({
  vendor,
}: {
  vendor: ReturnType<typeof detectVendor>
}) {
  const bodySrc =
    vendor === 'playstation'
      ? '/controller-bodies/ps5.png'
      : vendor === 'nintendo'
        ? '/controller-bodies/xboxone.png' // pas d'asset Switch — fallback Xbox
        : '/controller-bodies/xboxone.png'
  return (
    <div className="relative w-[460px] h-[300px] mx-auto flex items-center justify-center">
      <img
        src={bodySrc}
        alt="Manette"
        className="w-full h-full object-contain select-none"
        draggable={false}
        style={{ maxWidth: 'none' }}
      />
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   EDIT VIEW — sidebar + panel détail par catégorie
   Mirror de l'écran "Modifier la configuration" Nexus Input.
   ───────────────────────────────────────────────────────────── */
function EditView({
  config,
  setConfig,
  category,
  setCategory,
  onRemap,
  vendor,
}: {
  config: ControllerConfig
  setConfig: React.Dispatch<React.SetStateAction<ControllerConfig>>
  category: EditCategory
  setCategory: (c: EditCategory) => void
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  // Gyro & trackpad uniquement sur les manettes qui en ont :
  //   - Gyro  : PlayStation (DS4/DualSense), Switch Pro
  //   - Track : PlayStation (DS4/DualSense touchpad)
  // Xbox n'a ni l'un ni l'autre → on cache les onglets pour pas
  // tromper l'user (et éviter qu'il configure du gyro qui ne sera
  // jamais utilisé).
  const hasGyro = vendor === 'playstation' || vendor === 'nintendo'
  const hasTrackpad = vendor === 'playstation'
  const categories: Array<{ id: EditCategory; label: string; icon: typeof Gamepad2 }> = [
    { id: 'buttons', label: 'Boutons', icon: Gamepad2 },
    { id: 'dpad', label: 'Croix directionnelle', icon: Move },
    { id: 'triggers', label: 'Gâchettes', icon: ChevronRight },
    { id: 'joysticks', label: 'Joysticks', icon: Crosshair },
    ...(hasTrackpad
      ? [{ id: 'trackpads' as const, label: 'Trackpads', icon: CircleDot }]
      : []),
    ...(hasGyro
      ? [{ id: 'gyro' as const, label: 'Gyroscope', icon: Layers }]
      : []),
  ]
  // Si l'user était sur une catégorie maintenant cachée (ex. il
  // changeait sa DualSense pour une Xbox), bascule sur Boutons.
  useEffect(() => {
    if (category === 'gyro' && !hasGyro) setCategory('buttons')
    if (category === 'trackpads' && !hasTrackpad) setCategory('buttons')
  }, [category, hasGyro, hasTrackpad, setCategory])
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 min-h-[400px]">
      {/* Sidebar */}
      <aside className="border-r border-glass-border pr-3">
        <ul className="flex flex-col gap-0.5">
          {categories.map((c) => {
            const active = c.id === category
            const Icon = c.icon
            return (
              <li key={c.id}>
                <button
                  onClick={() => setCategory(c.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors',
                    active
                      ? 'bg-accent-primary/15 text-fg-primary border-l-2 border-accent-primary'
                      : 'text-fg-secondary hover:bg-[var(--surface-soft)] hover:text-fg-primary',
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{c.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      {/* Main panel */}
      <div className="overflow-y-auto pr-1">
        {category === 'buttons' && (
          <CategoryButtons config={config} onRemap={onRemap} vendor={vendor} />
        )}
        {category === 'dpad' && (
          <CategoryDpad config={config} onRemap={onRemap} vendor={vendor} />
        )}
        {category === 'triggers' && (
          <CategoryTriggers config={config} setConfig={setConfig} onRemap={onRemap} vendor={vendor} />
        )}
        {category === 'joysticks' && (
          <CategoryJoysticks config={config} setConfig={setConfig} onRemap={onRemap} vendor={vendor} />
        )}
        {category === 'trackpads' && (
          <CategoryTrackpads />
        )}
        {category === 'gyro' && (
          <CategoryGyro config={config} setConfig={setConfig} />
        )}
      </div>
    </div>
  )
}

function CategoryButtons({
  config,
  onRemap,
  vendor,
}: {
  config: ControllerConfig
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  const items: Array<{ from: VirtualButton; label: string }> = [
    { from: 'A', label: 'Bouton A' },
    { from: 'B', label: 'Bouton B' },
    { from: 'X', label: 'Bouton X' },
    { from: 'Y', label: 'Bouton Y' },
  ]
  const menuItems: Array<{ from: VirtualButton; label: string }> = [
    { from: 'BACK', label: 'Select / Back' },
    { from: 'START', label: 'Start / Menu' },
    { from: 'GUIDE', label: 'Guide / Home' },
  ]
  return (
    <div>
      <SectionHeader title="Boutons" />
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Boutons avant : comportement
      </p>
      <div className="flex flex-col gap-1.5 mb-5">
        {items.map((it) => (
          <RemapRow key={it.from} from={it.from} label={it.label} remap={config.remap} onRemap={onRemap} vendor={vendor} />
        ))}
      </div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Boutons menu
      </p>
      <div className="flex flex-col gap-1.5">
        {menuItems.map((it) => (
          <RemapRow key={it.from} from={it.from} label={it.label} remap={config.remap} onRemap={onRemap} vendor={vendor} />
        ))}
      </div>
    </div>
  )
}

function CategoryDpad({
  config,
  onRemap,
  vendor,
}: {
  config: ControllerConfig
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  const items: Array<{ from: VirtualButton; label: string }> = [
    { from: 'DPAD_UP', label: 'D-Pad Haut' },
    { from: 'DPAD_DOWN', label: 'D-Pad Bas' },
    { from: 'DPAD_LEFT', label: 'D-Pad Gauche' },
    { from: 'DPAD_RIGHT', label: 'D-Pad Droit' },
  ]
  return (
    <div>
      <SectionHeader title="Croix directionnelle" />
      <div className="flex flex-col gap-1.5">
        {items.map((it) => (
          <RemapRow key={it.from} from={it.from} label={it.label} remap={config.remap} onRemap={onRemap} vendor={vendor} />
        ))}
      </div>
    </div>
  )
}

function CategoryTriggers({
  config,
  setConfig,
  onRemap,
  vendor,
}: {
  config: ControllerConfig
  setConfig: React.Dispatch<React.SetStateAction<ControllerConfig>>
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  return (
    <div>
      <SectionHeader title="Gâchettes" />
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Bumpers
      </p>
      <div className="flex flex-col gap-1.5 mb-5">
        <RemapRow from="LB" label="Bumper Gauche (LB)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
        <RemapRow from="RB" label="Bumper Droit (RB)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
      </div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Gâchettes analogiques
      </p>
      <div className="flex flex-col gap-1.5 mb-5">
        <RemapRow from="LT" label="Gâchette Gauche (LT)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
        <RemapRow from="RT" label="Gâchette Droite (RT)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
      </div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Seuils d'activation
      </p>
      <div className="grid grid-cols-2 gap-3">
        <SliderRow
          label="Seuil LT"
          value={config.triggers.left ?? 0.05}
          onChange={(v) =>
            setConfig({ ...config, triggers: { ...config.triggers, left: v } })
          }
        />
        <SliderRow
          label="Seuil RT"
          value={config.triggers.right ?? 0.05}
          onChange={(v) =>
            setConfig({ ...config, triggers: { ...config.triggers, right: v } })
          }
        />
      </div>
    </div>
  )
}

function CategoryJoysticks({
  config,
  setConfig,
  onRemap,
  vendor,
}: {
  config: ControllerConfig
  setConfig: React.Dispatch<React.SetStateAction<ControllerConfig>>
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  return (
    <div>
      <SectionHeader title="Joysticks" />
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Clics
      </p>
      <div className="flex flex-col gap-1.5 mb-5">
        <RemapRow from="LSTICK" label="Clic Stick Gauche (L3)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
        <RemapRow from="RSTICK" label="Clic Stick Droit (R3)" remap={config.remap} onRemap={onRemap} vendor={vendor} />
      </div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
        Deadzones
      </p>
      <div className="grid grid-cols-2 gap-3 mb-5">
        <SliderRow
          label="Deadzone Stick Gauche"
          value={config.deadzones.leftStick ?? 0.1}
          onChange={(v) =>
            setConfig({
              ...config,
              deadzones: { ...config.deadzones, leftStick: v },
            })
          }
        />
        <SliderRow
          label="Deadzone Stick Droit"
          value={config.deadzones.rightStick ?? 0.1}
          onChange={(v) =>
            setConfig({
              ...config,
              deadzones: { ...config.deadzones, rightStick: v },
            })
          }
        />
      </div>
      <ToggleRow
        label="Inverser l'axe Y du stick droit"
        value={config.invertY}
        onChange={(v) => setConfig({ ...config, invertY: v })}
      />
    </div>
  )
}

function CategoryTrackpads() {
  return (
    <div>
      <SectionHeader title="Trackpads" />
      <p className="text-xs text-fg-muted">
        Les trackpads (DualSense / DualShock 4) seront mappés via Phase 2.
        Pour l'instant ils restent en passthrough natif.
      </p>
    </div>
  )
}

function CategoryGyro({
  config,
  setConfig,
}: {
  config: ControllerConfig
  setConfig: React.Dispatch<React.SetStateAction<ControllerConfig>>
}) {
  return (
    <div>
      <SectionHeader title="Gyroscope" />
      <ToggleRow
        label="Activer le gyroscope"
        value={config.gyro.enabled}
        onChange={(v) =>
          setConfig({ ...config, gyro: { ...config.gyro, enabled: v } })
        }
      />
      {config.gyro.enabled && (
        <>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-sm text-fg-secondary">Mode</span>
            <select
              value={config.gyro.mode}
              onChange={(e) =>
                setConfig({
                  ...config,
                  gyro: {
                    ...config.gyro,
                    mode: e.target.value as 'rightStick' | 'mouse',
                  },
                })
              }
              className="h-8 px-2 rounded bg-bg-secondary border border-glass-border text-sm text-fg-primary"
            >
              <option value="rightStick">Joystick droit</option>
              <option value="mouse">Souris</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <SliderRow
              label="Sensibilité X"
              value={config.gyro.sensitivityX}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(v) =>
                setConfig({
                  ...config,
                  gyro: { ...config.gyro, sensitivityX: v },
                })
              }
            />
            <SliderRow
              label="Sensibilité Y"
              value={config.gyro.sensitivityY}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(v) =>
                setConfig({
                  ...config,
                  gyro: { ...config.gyro, sensitivityY: v },
                })
              }
            />
          </div>
        </>
      )}
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-base font-bold text-fg-primary mb-3 pb-2 border-b border-glass-border">
      {title}
    </h3>
  )
}

function RemapRow({
  from,
  label,
  remap,
  onRemap,
  vendor,
}: {
  from: VirtualButton
  label: string
  remap: ControllerConfig['remap']
  onRemap: (from: VirtualButton, to: VirtualButton | '') => void
  vendor: ReturnType<typeof detectVendor>
}) {
  const value = remap[from] ?? ''
  return (
    <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--surface-soft)] border border-glass-border">
      <ControllerGlyph button={from} vendor={vendor} />
      <span className="text-xs font-mono flex-1 truncate text-fg-secondary">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onRemap(from, e.target.value as VirtualButton | '')}
        className="h-7 px-1.5 rounded bg-bg-secondary border border-glass-border text-xs text-fg-primary min-w-[170px]"
      >
        <option value="">— défaut ({BUTTON_LABEL[from]})</option>
        {VIRTUAL_BUTTONS.map((opt) => (
          <option key={opt} value={opt}>
            {BUTTON_LABEL[opt]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="p-1 rounded hover:bg-[var(--surface-soft-hover)] text-fg-muted hover:text-fg-primary"
        title="Réglages avancés (Phase 2)"
      >
        <SettingsIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function SliderRow({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-secondary">{label}</span>
        <span className="text-[11px] font-mono text-fg-muted">
          {value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="accent-accent-primary"
      />
    </div>
  )
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-sm text-fg-secondary">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={cn(
          'relative w-10 h-5 rounded-full transition-colors',
          value ? 'bg-accent-primary' : 'bg-fg-muted/30',
        )}
        aria-pressed={value}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform',
            value && 'translate-x-5',
          )}
        />
      </button>
    </label>
  )
}

function VendorBadge({
  vendor,
}: {
  vendor: ReturnType<typeof detectVendor>
}) {
  const map: Record<ReturnType<typeof detectVendor>, { label: string; bg: string; fg: string }> = {
    xbox: { label: 'XBOX', bg: 'bg-[#107c10]/20', fg: 'text-[#7fd17f]' },
    playstation: { label: 'PS', bg: 'bg-[#0070d1]/20', fg: 'text-[#5fa8e8]' },
    nintendo: { label: 'NSW', bg: 'bg-[#e60012]/20', fg: 'text-[#ff6b7a]' },
    generic: { label: 'PAD', bg: 'bg-fg-muted/20', fg: 'text-fg-muted' },
  }
  const { label, bg, fg } = map[vendor]
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center w-9 h-6 rounded text-[10px] font-bold tracking-wider border border-glass-border shrink-0',
        bg,
        fg,
      )}
    >
      {label}
    </span>
  )
}
