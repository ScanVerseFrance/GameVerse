import { Check, Edit3, Trash2, Download as DownloadIcon } from '@/lib/icons'
import { motion } from 'framer-motion'
import type { Theme } from '@/types/theme.types'
import { cn } from '@/utils/cn'

interface ThemePreviewCardProps {
  theme: Theme
  active: boolean
  onApply: () => void
  onEdit: () => void
  onDelete?: () => void
  onExport: () => void
}

export function ThemePreviewCard({ theme, active, onApply, onEdit, onDelete, onExport }: ThemePreviewCardProps) {
  const c = theme.colors
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      className={cn(
        'group relative rounded-lg overflow-hidden border transition-all cursor-pointer',
        active ? 'border-accent-primary/60 shadow-glow' : 'border-glass-border hover:border-white/20'
      )}
      style={{ background: c.bgSecondary }}
      onClick={onApply}
    >
      <div
        className="h-28 relative overflow-hidden"
        style={{
          background: `linear-gradient(135deg, ${c.bgPrimary} 0%, ${c.bgTertiary} 60%, ${c.bgSecondary} 100%)`,
        }}
      >
        <div
          className="absolute inset-0 opacity-60"
          style={{
            background: `radial-gradient(circle at 20% 30%, ${c.accentPrimary}50, transparent 50%), radial-gradient(circle at 80% 70%, ${c.accentSecondary}40, transparent 55%)`,
          }}
        />
        <div className="absolute bottom-3 left-3 right-3 flex gap-1.5">
          {[c.accentPrimary, c.accentSecondary, c.success, c.warning, c.error].map((col, i) => (
            <div
              key={i}
              className="flex-1 h-2 rounded-full border"
              style={{ background: col, borderColor: c.glassBorder }}
            />
          ))}
        </div>
        {active && (
          <div className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center shadow-glow" style={{ background: `linear-gradient(135deg, ${c.accentPrimary}, ${c.accentSecondary})` }}>
            <Check className="w-3.5 h-3.5 text-white" />
          </div>
        )}
      </div>

      <div className="p-4 flex items-center justify-between" style={{ color: c.textPrimary }}>
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{theme.name}</p>
          <p className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: c.textMuted }}>
            {theme.mode} {theme.isBuiltin ? '· intégré' : '· personnalisé'}
          </p>
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onExport()
            }}
            className="p-1.5 rounded-sm hover:bg-white/10"
            title="Exporter"
            style={{ color: c.textSecondary }}
          >
            <DownloadIcon className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
            className="p-1.5 rounded-sm hover:bg-white/10"
            title={theme.isBuiltin ? 'Dupliquer & modifier' : 'Modifier'}
            style={{ color: c.textSecondary }}
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              className="p-1.5 rounded-sm hover:bg-white/10"
              title="Supprimer"
              style={{ color: c.error }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
