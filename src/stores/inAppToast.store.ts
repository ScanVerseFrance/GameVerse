/**
 * InAppToast store — toasts éphémères affichés en bas à droite de la
 * fenêtre principale (pas dans l'overlay window Steam-style). Pattern
 * ScanVerse "react-hot-toast" : push une fois, auto-dismiss après 3 s,
 * stack visible si plusieurs.
 *
 * Différent du `toast.store` (Steam overlay window — c'est pour les
 * notifs système comme "ami lance un jeu"). Celui-ci est pour les
 * feedbacks d'action user immédiats : "Profil mis à jour ✓",
 * "Échec de la sauvegarde", etc.
 */
import { create } from 'zustand'

export type InAppToastKind = 'success' | 'error' | 'info'

export interface InAppToastItem {
  id: string
  kind: InAppToastKind
  message: string
  /** Quand la toast a été push — pour la sort/anim layout key. */
  createdAt: number
  /** Durée avant auto-dismiss en ms. Défaut 3000 (parité ScanVerse). */
  durationMs: number
}

interface InAppToastState {
  toasts: InAppToastItem[]
  push: (input: { kind?: InAppToastKind; message: string; durationMs?: number }) => void
  dismiss: (id: string) => void
}

const DEFAULT_DURATION_MS = 3000
const MAX_VISIBLE = 4

export const useInAppToastStore = create<InAppToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const item: InAppToastItem = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind ?? 'info',
      message: input.message,
      createdAt: Date.now(),
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
    }
    set((state) => ({
      // Cap à MAX_VISIBLE — au-delà on drop les plus vieux pour
      // éviter qu'une rafale d'erreurs bouffe l'écran.
      toasts: [...state.toasts, item].slice(-MAX_VISIBLE),
    }))
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

/* Helpers raccourcis — usage identique à react-hot-toast :
 *   toast.success("Profil mis à jour")
 *   toast.error("Échec de la sauvegarde")
 *   toast.info("Connexion en cours…")
 */
export const toast = {
  success: (message: string, durationMs?: number) =>
    useInAppToastStore.getState().push({ kind: 'success', message, durationMs }),
  error: (message: string, durationMs?: number) =>
    useInAppToastStore.getState().push({ kind: 'error', message, durationMs }),
  info: (message: string, durationMs?: number) =>
    useInAppToastStore.getState().push({ kind: 'info', message, durationMs }),
}
