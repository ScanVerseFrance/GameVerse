import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Star, ChevronUp, ChevronDown, Trash2, Edit3, MessageSquare, Languages, Loader2 } from 'lucide-react'
import type { Review } from '@/types/social.types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StarRating } from '@/components/ui/StarRating'
import { useAuthStore } from '@/stores/auth.store'
import { cn } from '@/utils/cn'

interface ReviewsSectionProps {
  externalGameId: string
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

/**
 * One review can be in one of three translation states:
 *   - idle      : showing the original text
 *   - loading   : translation request in flight
 *   - translated: translation displayed (click "Original" to revert)
 *
 * State lives at the section level (Map keyed by review id) instead
 * of inside each review card so a single API result can populate
 * the same review across re-renders without losing the cache.
 */
interface TranslationState {
  phase: 'idle' | 'loading' | 'translated' | 'error'
  translation?: string
  sourceLang?: string
  error?: string
}

export function ReviewsSection({ externalGameId }: ReviewsSectionProps) {
  const user = useAuthStore((s) => s.user)
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [rating, setRating] = useState(5)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({})

  async function toggleTranslate(reviewId: string, sourceText: string): Promise<void> {
    const cur = translations[reviewId]
    if (cur?.phase === 'translated') {
      // Revert to original — keep the cached translation so a second
      // click is instant rather than re-hitting the API.
      setTranslations((prev) => ({
        ...prev,
        [reviewId]: { ...cur, phase: 'idle' },
      }))
      return
    }
    if (cur?.translation) {
      // Re-show cached translation.
      setTranslations((prev) => ({
        ...prev,
        [reviewId]: { ...cur, phase: 'translated' },
      }))
      return
    }
    // First-time translation request.
    setTranslations((prev) => ({ ...prev, [reviewId]: { phase: 'loading' } }))
    const res = await window.nexus.translation.translate(sourceText, 'fr')
    if (res.ok && res.translation) {
      setTranslations((prev) => ({
        ...prev,
        [reviewId]: {
          phase: 'translated',
          translation: res.translation,
          sourceLang: res.sourceLang,
        },
      }))
    } else {
      setTranslations((prev) => ({
        ...prev,
        [reviewId]: { phase: 'error', error: res.error ?? 'erreur' },
      }))
    }
  }

  const myReview = user ? reviews.find((r) => r.userId === user.id) ?? null : null

  const load = useCallback(async () => {
    setLoading(true)
    const res = await window.nexus.social.listReviews(externalGameId, user?.id)
    if (res.ok) setReviews(res.reviews)
    setLoading(false)
  }, [externalGameId, user?.id])

  useEffect(() => {
    void load()
  }, [load])

  function openEditor() {
    if (myReview) {
      setRating(myReview.rating)
      setContent(myReview.content ?? '')
    } else {
      setRating(5)
      setContent('')
    }
    setEditing(true)
  }

  async function saveReview() {
    if (!user) return
    setSaving(true)
    const res = await window.nexus.social.upsertReview(user.id, externalGameId, rating, content.trim() || null)
    setSaving(false)
    if (res.ok) {
      setEditing(false)
      await load()
    }
  }

  async function deleteReview() {
    if (!user || !myReview) return
    await window.nexus.social.deleteReview(myReview.id, user.id)
    setEditing(false)
    await load()
  }

  async function vote(reviewId: string, direction: 1 | -1 | 0) {
    if (!user) return
    await window.nexus.social.voteReview(user.id, reviewId, direction)
    await load()
  }

  const avgRating = reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : 0

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <MessageSquare className="w-4 h-4 text-accent-primary" />
          <h3 className="font-display font-bold text-lg text-fg-primary">Avis de la communauté</h3>
          {reviews.length > 0 && (
            <span className="flex items-center gap-1.5 text-sm text-fg-secondary">
              <Star className="w-3.5 h-3.5 fill-warning text-warning" />
              <span className="font-mono font-semibold">{avgRating.toFixed(1)}</span>
              <span className="text-fg-muted">· {reviews.length}</span>
            </span>
          )}
        </div>
        {user && !editing && (
          <Button
            size="sm"
            variant="outline"
            leftIcon={myReview ? <Edit3 className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}
            onClick={openEditor}
          >
            {myReview ? 'Modifier mon avis' : 'Écrire un avis'}
          </Button>
        )}
      </div>

      {editing && user && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 p-4 rounded-md bg-[var(--surface-soft)] border border-glass-border"
        >
          <div className="flex items-center gap-3 mb-3">
            <span className="text-sm text-fg-secondary">Ta note&nbsp;:</span>
            <StarRating value={rating} onChange={setRating} size={24} />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Partage ton ressenti (optionnel)…"
            className="w-full bg-bg-secondary border border-glass-border hover:border-[var(--surface-soft-border)] focus:border-accent-primary/60 focus:outline-none rounded-md px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted resize-none mb-3"
          />
          <div className="flex justify-between items-center gap-2">
            {myReview ? (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => void deleteReview()}
                className="text-error hover:text-error"
              >
                Supprimer
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Annuler
              </Button>
              <Button size="sm" onClick={() => void saveReview()} loading={saving}>
                Enregistrer
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {loading ? (
        <div className="py-6 text-center text-sm text-fg-muted">Chargement des avis…</div>
      ) : reviews.length === 0 ? (
        <div className="py-6 text-center text-sm text-fg-muted">
          Aucun avis pour le moment.{user && ' Sois le premier.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {reviews.map((r) => (
            <div key={r.id} className="p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                  {r.avatarPath ? (
                    <img src={r.avatarPath} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-sm font-bold text-white">
                      {(r.displayName ?? r.username).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-fg-primary">{r.displayName ?? r.username}</span>
                    {r.userId === user?.id && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-primary/15 text-accent-primary">
                        you
                      </span>
                    )}
                    <StarRating value={r.rating} size={12} readonly />
                    <span className="text-xs text-fg-muted">· {relativeTime(r.createdAt)}</span>
                  </div>
                  {r.content && (() => {
                    const tr = translations[r.id]
                    const showTranslated = tr?.phase === 'translated' && tr.translation
                    return (
                      <>
                        <p className="text-sm text-fg-secondary mt-1.5 leading-relaxed whitespace-pre-wrap">
                          {showTranslated ? tr!.translation : r.content}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                          <button
                            onClick={() => void toggleTranslate(r.id, r.content!)}
                            disabled={tr?.phase === 'loading'}
                            className="inline-flex items-center gap-1 text-fg-muted hover:text-accent-primary transition-colors disabled:opacity-50"
                          >
                            {tr?.phase === 'loading' ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Languages className="w-3 h-3" />
                            )}
                            {showTranslated
                              ? 'Voir l\'original'
                              : tr?.phase === 'loading'
                                ? 'Traduction…'
                                : 'Traduire'}
                          </button>
                          {showTranslated && tr?.sourceLang && (
                            <span className="text-fg-muted">
                              (traduit du {tr.sourceLang})
                            </span>
                          )}
                          {tr?.phase === 'error' && (
                            <span className="text-error">
                              Échec traduction
                            </span>
                          )}
                        </div>
                      </>
                    )
                  })()}
                  <div className="flex items-center gap-1 mt-2">
                    <button
                      onClick={() => void vote(r.id, r.myVote === 1 ? 0 : 1)}
                      className={cn(
                        'flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs transition-colors',
                        r.myVote === 1
                          ? 'bg-success/15 text-success'
                          : 'text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary'
                      )}
                    >
                      <ChevronUp className="w-3 h-3" />
                      {r.upvotes}
                    </button>
                    <button
                      onClick={() => void vote(r.id, r.myVote === -1 ? 0 : -1)}
                      className={cn(
                        'flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs transition-colors',
                        r.myVote === -1
                          ? 'bg-error/15 text-error'
                          : 'text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary'
                      )}
                    >
                      <ChevronDown className="w-3 h-3" />
                      {r.downvotes}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
