/**
 * Lightweight password-strength meter. No zxcvbn (1.2 MB bundle for
 * what amounts to "is the password good enough to register?"). The
 * scorer below buckets passwords into 5 levels by counting positive
 * signals (length, character-class variety, dictionary distance) and
 * subtracting common-pattern penalties (sequences, repeats, leet
 * variants of the username if provided).
 *
 * Used in the CloudAuthGate register flow. Display-only — the server
 * still enforces its own 8-char minimum at the API layer.
 */

export type StrengthLevel = 0 | 1 | 2 | 3 | 4

interface StrengthResult {
  level: StrengthLevel
  label: string
  /** Tailwind class for the bar's fill colour. */
  color: string
  /** Short actionable hint for the user. Empty when password is strong. */
  hint: string
}

const COMMON_PASSWORDS = new Set([
  'password',
  'motdepasse',
  '123456',
  '12345678',
  'qwerty',
  'azerty',
  'azertyuiop',
  'football',
  'admin',
  'welcome',
  'letmein',
  'iloveyou',
  'dragon',
  '111111',
  '000000',
  'abc123',
  'pokemon',
  'minecraft',
  'starwars',
  'monkey',
])

function isSequential(s: string): boolean {
  if (s.length < 4) return false
  const lower = s.toLowerCase()
  // ASCII run forward or backward (abcd, 1234, dcba…)
  for (let i = 0; i <= lower.length - 4; i++) {
    const c0 = lower.charCodeAt(i)
    if (
      lower.charCodeAt(i + 1) === c0 + 1 &&
      lower.charCodeAt(i + 2) === c0 + 2 &&
      lower.charCodeAt(i + 3) === c0 + 3
    ) {
      return true
    }
    if (
      lower.charCodeAt(i + 1) === c0 - 1 &&
      lower.charCodeAt(i + 2) === c0 - 2 &&
      lower.charCodeAt(i + 3) === c0 - 3
    ) {
      return true
    }
  }
  return false
}

function hasLongRepeat(s: string): boolean {
  // aaaa, 1111, !!!! — three identical chars in a row.
  for (let i = 0; i < s.length - 3; i++) {
    if (s[i] === s[i + 1] && s[i] === s[i + 2] && s[i] === s[i + 3]) {
      return true
    }
  }
  return false
}

/**
 * Score in 0..4. Heuristic, intentionally simple:
 *
 *   length:
 *     <8  → -2
 *     8-9 → 0
 *     10-11 → +1
 *     12-15 → +2
 *     16+   → +3
 *   variety: +1 per class present beyond the first (lower / upper /
 *            digit / symbol) — max +3.
 *   penalties:
 *     common password (case-insensitive) → -3
 *     sequential run of 4+               → -1
 *     long repeat (xxxx)                 → -1
 *     contains username (3+ chars)       → -2
 *
 * Final score is clamped to 0..4. Empty → 0.
 */
export function scorePassword(password: string, username?: string): StrengthLevel {
  if (!password) return 0
  const len = password.length
  let score = 0

  if (len < 8) score -= 2
  else if (len < 10) score += 0
  else if (len < 12) score += 1
  else if (len < 16) score += 2
  else score += 3

  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password))
  score += Math.max(0, classes - 1)

  if (COMMON_PASSWORDS.has(password.toLowerCase())) score -= 3
  if (isSequential(password)) score -= 1
  if (hasLongRepeat(password)) score -= 1
  if (
    username &&
    username.length >= 3 &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    score -= 2
  }

  if (score < 0) return 0
  if (score > 4) return 4
  return score as StrengthLevel
}

const LEVELS: Record<StrengthLevel, { label: string; color: string; hint: string }> = {
  0: {
    label: 'Très faible',
    color: 'bg-error',
    hint: 'Trop court ou trop courant — vise au moins 8 caractères avec un mélange.',
  },
  1: {
    label: 'Faible',
    color: 'bg-error',
    hint: 'Ajoute majuscules, chiffres ou symboles pour renforcer.',
  },
  2: {
    label: 'Correct',
    color: 'bg-warning',
    hint: 'Pas mal — un peu plus long et tu passes en fort.',
  },
  3: {
    label: 'Fort',
    color: 'bg-success',
    hint: '',
  },
  4: {
    label: 'Très fort',
    color: 'bg-success',
    hint: '',
  },
}

export function evaluatePassword(
  password: string,
  username?: string
): StrengthResult {
  const level = scorePassword(password, username)
  const def = LEVELS[level]
  return { level, label: def.label, color: def.color, hint: def.hint }
}

/**
 * Visual: 4-segment bar (filled up to `level + 1`) + label + hint.
 * Render under the password Field; pass `username` so we can flag
 * "password contains your username" as a weakness.
 */
export function PasswordStrength({
  password,
  username,
}: {
  password: string
  username?: string
}) {
  if (!password) return null
  const r = evaluatePassword(password, username)
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`flex-1 h-1.5 rounded-full transition-colors ${
              i <= r.level
                ? r.color
                : 'bg-[var(--surface-medium)]'
            }`}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-mono uppercase tracking-wider ${
            r.level >= 3
              ? 'text-success'
              : r.level === 2
              ? 'text-warning'
              : 'text-error'
          }`}
        >
          {r.label}
        </span>
        {r.hint && (
          <span className="text-[10px] text-fg-muted text-right leading-tight">
            {r.hint}
          </span>
        )}
      </div>
    </div>
  )
}
