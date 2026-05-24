/**
 * Panel "Performance" — HUD temps réel CPU / GPU / RAM / disque. Le
 * FPS du jeu lui-même est plus dur à choper (nécessite un overlay
 * DirectX/Vulkan/OpenGL hook genre RTSS). Pour l'instant on remonte
 * les métriques système qu'on peut lire via le main process.
 *
 * IPC : `overlay:getPerfSnapshot` retourne {cpu, gpu, ram, diskRead, ...}
 * chaque seconde. Le panel s'abonne en boucle setInterval(1000).
 */
import { useEffect, useState } from 'react'
import { Activity, Cpu, MemoryStick, HardDrive } from '@/lib/icons'
import { PanelShell } from './OverlayFriendsPanel'

interface PerfSnapshot {
  cpu: { percent: number; cores: number; model: string }
  ram: { usedBytes: number; totalBytes: number; percent: number }
  gpu: { percent: number; memUsedMB: number; memTotalMB: number; model: string } | null
  disk: { readBps: number; writeBps: number }
  uptimeSeconds: number
}

const HISTORY_LENGTH = 60 // 60 points × 1s = 1 min

export function OverlayPerfPanel() {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null)
  const [history, setHistory] = useState<{ cpu: number[]; gpu: number[] }>({
    cpu: [],
    gpu: [],
  })

  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const res = await window.nexus.overlay.getPerfSnapshot?.()
        if (cancelled || !res?.ok || !res.snapshot) return
        const s = res.snapshot as PerfSnapshot
        setSnap(s)
        setHistory((prev) => ({
          cpu: [...prev.cpu, s.cpu.percent].slice(-HISTORY_LENGTH),
          gpu: [...prev.gpu, s.gpu?.percent ?? 0].slice(-HISTORY_LENGTH),
        }))
      } catch {
        /* skip */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return (
    <PanelShell title="Performance" icon={<Activity className="w-5 h-5" />}>
      {!snap ? (
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
          Collecte des métriques…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <MetricRow
            icon={<Cpu className="w-4 h-4" />}
            label="CPU"
            value={`${snap.cpu.percent.toFixed(1)}%`}
            sub={`${snap.cpu.cores} cœurs · ${snap.cpu.model.slice(0, 40)}`}
            history={history.cpu}
            color="#22c55e"
          />
          {snap.gpu && (
            <MetricRow
              icon={<Activity className="w-4 h-4" />}
              label="GPU"
              value={`${snap.gpu.percent.toFixed(1)}%`}
              sub={`${snap.gpu.memUsedMB} / ${snap.gpu.memTotalMB} MB · ${snap.gpu.model.slice(0, 40)}`}
              history={history.gpu}
              color="#a855f7"
            />
          )}
          <MetricRow
            icon={<MemoryStick className="w-4 h-4" />}
            label="RAM"
            value={`${snap.ram.percent.toFixed(1)}%`}
            sub={`${formatGb(snap.ram.usedBytes)} / ${formatGb(snap.ram.totalBytes)}`}
            history={null}
            color="#f59e0b"
          />
          <MetricRow
            icon={<HardDrive className="w-4 h-4" />}
            label="Disque"
            value={`${formatRate(snap.disk.readBps)} R · ${formatRate(snap.disk.writeBps)} W`}
            sub={null}
            history={null}
            color="#0ea5e9"
          />
          <p className="text-[10px] text-fg-muted text-center pt-2 font-mono">
            Uptime : {formatUptime(snap.uptimeSeconds)}
          </p>
        </div>
      )}
    </PanelShell>
  )
}

function MetricRow({
  icon,
  label,
  value,
  sub,
  history,
  color,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string | null
  history: number[] | null
  color: string
}) {
  return (
    <div className="rounded-md bg-white/5 border border-white/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span style={{ color }}>{icon}</span>
          <span className="text-xs font-bold text-fg-primary uppercase tracking-wider">
            {label}
          </span>
        </div>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {value}
        </span>
      </div>
      {sub && (
        <p className="text-[10px] text-fg-muted mt-1 font-mono truncate">{sub}</p>
      )}
      {history && history.length > 1 && (
        <svg viewBox="0 0 600 60" className="w-full h-10 mt-2" preserveAspectRatio="none">
          <polyline
            points={history
              .map((v, i) => `${(i / (HISTORY_LENGTH - 1)) * 600},${60 - (v / 100) * 56 - 2}`)
              .join(' ')}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB'
}

function formatRate(bps: number): string {
  if (bps < 1024) return `${bps} B/s`
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
}

function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
