import { create } from 'zustand'

const STORAGE_KEY = 'nexus.pinned-games'

/**
 * Jeux épinglés en haut de la bibliothèque, distinct des favoris :
 *   - Favorite (DB)   : filtre logique "j'aime ce jeu"
 *   - Pinned  (local) : ordre d'affichage forcé en tête de liste
 *
 * Stocké en localStorage (préférence utilisateur par machine, ne suit
 * pas le cloud — c'est volontaire, l'épinglage est très contextuel
 * au device : pas pertinent sur un PC où le jeu n'est pas installé).
 */
interface PinnedState {
  pinned: ReadonlySet<string>
  toggle: (gameId: string) => void
  isPinned: (gameId: string) => boolean
}

function loadInitial(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function persist(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    /* quota → ignore, l'épinglage reste en mémoire pour la session */
  }
}

export const usePinnedStore = create<PinnedState>((set, get) => ({
  pinned: loadInitial(),
  toggle: (gameId) => {
    const next = new Set(get().pinned)
    if (next.has(gameId)) next.delete(gameId)
    else next.add(gameId)
    persist(next)
    set({ pinned: next })
  },
  isPinned: (gameId) => get().pinned.has(gameId),
}))
