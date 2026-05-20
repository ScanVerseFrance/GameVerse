/**
 * Helpers partagés par les listeners clavier globaux (useGlobalShortcuts,
 * KeyboardShortcutsDialog, CommandPalette).
 */

export function isModifierEvent(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

/** True quand l'événement vient d'un champ de saisie — les shortcuts globaux
 *  doivent céder le pas pour ne pas bloquer la frappe normale. */
export function shouldIgnoreKeyboardEvent(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}
