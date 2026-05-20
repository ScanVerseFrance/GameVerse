/**
 * Render a review body with Discord-style ||spoiler|| tags.
 *
 * Spoilers are rendered as a dark pill that blurs the text until the
 * user clicks. We deliberately keep the surface area small — no
 * markdown, no @mentions, no links — because the spoiler logic is
 * the only token that demands client-side parsing. Adding more
 * markup later is just additional patterns in `parseTokens`.
 *
 * Parser invariants:
 *   • Spoilers nest? No — ||a||b||c|| renders as [spoiler a][text b][spoiler c].
 *   • Unclosed `||` at end of string renders as plain text (visible
 *     ||) so a user typing "the boss is amazing||" sees their literal
 *     intent until they close it.
 *   • Empty spoilers `||  ||` are dropped entirely — they're a
 *     no-op and would just leave an empty pill.
 *
 * ScanVerse comic uses the same convention — see C:\Dev\ComicScan\aaaa
 * for the reference implementation. We mirror the visual treatment
 * so users moving between the two apps get identical UX.
 */
import { useState } from 'react'
import { cn } from '@/utils/cn'

interface ReviewBodyProps {
  content: string
  className?: string
}

type Token = { kind: 'text' | 'spoiler'; value: string }

/**
 * Split a string into text + spoiler tokens. Returns the original
 * content as a single text token when no spoiler is present.
 */
function parseTokens(input: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < input.length) {
    const open = input.indexOf('||', i)
    if (open === -1) {
      out.push({ kind: 'text', value: input.slice(i) })
      break
    }
    if (open > i) {
      out.push({ kind: 'text', value: input.slice(i, open) })
    }
    const close = input.indexOf('||', open + 2)
    if (close === -1) {
      // Unclosed marker — render the rest verbatim including the ||
      out.push({ kind: 'text', value: input.slice(open) })
      break
    }
    const body = input.slice(open + 2, close).trim()
    if (body.length > 0) {
      out.push({ kind: 'spoiler', value: body })
    }
    i = close + 2
  }
  return out
}

function SpoilerPill({ children }: { children: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      className={cn(
        'inline-block px-1.5 mx-0.5 rounded-sm align-baseline transition-colors',
        revealed
          ? 'bg-black/20 text-fg-primary cursor-default'
          : 'bg-black/70 text-transparent cursor-pointer hover:bg-black/55',
      )}
      title={revealed ? '' : 'Spoiler — clique pour révéler'}
      style={revealed ? undefined : { textShadow: 'none' }}
      aria-expanded={revealed}
    >
      {revealed ? children : <span aria-hidden="true">{children}</span>}
      {!revealed && <span className="sr-only">Spoiler masqué</span>}
    </button>
  )
}

export function ReviewBody({ content, className }: ReviewBodyProps) {
  const tokens = parseTokens(content)
  return (
    <p className={cn('text-sm text-fg-secondary leading-relaxed whitespace-pre-wrap break-words', className)}>
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <span key={i}>{t.value}</span>
        ) : (
          <SpoilerPill key={i}>{t.value}</SpoilerPill>
        ),
      )}
    </p>
  )
}
