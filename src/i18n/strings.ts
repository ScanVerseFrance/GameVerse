/**
 * i18n framework — phase 1: extract the most-visible UI strings into
 * a lookup table so future locales drop in trivially.
 *
 * Hydra ships full i18n via i18next with en/fr/es/de/pt/zh/… — we
 * start with FR only (matches the entire current launcher) but
 * structure the strings so swapping to another locale is a one-file
 * change.
 *
 * Usage:
 *   import { t } from '@/i18n/strings'
 *   <button>{t('nav.library')}</button>
 *
 * Missing keys fall back to the key itself (visible as a TODO) so
 * lazy / incomplete migrations are obvious.
 */

export type LocaleId = 'fr' | 'en'

const FR = {
  // Navigation
  'nav.home': 'Accueil',
  'nav.library': 'Bibliothèque',
  'nav.discover': 'Découvrir',
  'nav.downloads': 'Téléchargements',
  'nav.community': 'Communauté',
  'nav.bigPicture': 'Big Picture',
  'nav.settings': 'Paramètres',
  'nav.profile': 'Profil',
  // Common actions
  'action.cancel': 'Annuler',
  'action.save': 'Enregistrer',
  'action.close': 'Fermer',
  'action.confirm': 'Confirmer',
  'action.delete': 'Supprimer',
  'action.edit': 'Modifier',
  'action.refresh': 'Rafraîchir',
  'action.retry': 'Réessayer',
  'action.import': 'Importer',
  'action.export': 'Exporter',
  'action.download': 'Télécharger',
  'action.install': 'Installer',
  'action.uninstall': 'Désinstaller',
  'action.play': 'Jouer',
  'action.pause': 'Pause',
  'action.resume': 'Reprendre',
  'action.stop': 'Arrêter',
  'action.copy': 'Copier',
  'action.open': 'Ouvrir',
  'action.choose': 'Choisir',
  'action.change': 'Changer',
  'action.manage': 'Gérer',
  'action.viewAll': 'Voir tout',
  // Library statuses
  'lib.status.wishlist': 'Wishlist',
  'lib.status.notStarted': 'À jouer',
  'lib.status.inProgress': 'En cours',
  'lib.status.completed': 'Terminé',
  'lib.status.abandoned': 'Abandonné',
  // Download states
  'dl.queued': 'En attente',
  'dl.downloading': 'En cours',
  'dl.paused': 'Pause',
  'dl.completed': 'Terminé',
  'dl.error': 'Erreur',
  // Settings sections
  'settings.general': 'Général',
  'settings.appearance': 'Apparence',
  'settings.personalisation': 'Personnalisation',
  'settings.downloads': 'Téléchargements',
  'settings.debrid': 'Services Debrid',
  'settings.account': 'Compte',
  'settings.notifications': 'Notifications',
  'settings.integrations': 'Intégrations',
  'settings.advanced': 'Avancé',
  'settings.privacy': 'Confidentialité',
  'settings.about': 'À propos',
  // Toasts / dialogs
  'common.loading': 'Chargement…',
  'common.noResults': 'Aucun résultat',
  'common.error': 'Erreur',
  'common.success': 'OK',
  'common.unknown': 'Inconnu',
  'common.never': 'Jamais',
  'common.yes': 'Oui',
  'common.no': 'Non',
} as const

const EN: Partial<Record<keyof typeof FR, string>> = {
  'nav.home': 'Home',
  'nav.library': 'Library',
  'nav.discover': 'Discover',
  'nav.downloads': 'Downloads',
  'nav.community': 'Community',
  'nav.bigPicture': 'Big Picture',
  'nav.settings': 'Settings',
  'nav.profile': 'Profile',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.close': 'Close',
  'action.confirm': 'Confirm',
  'action.delete': 'Delete',
  'action.edit': 'Edit',
  'action.refresh': 'Refresh',
  'action.retry': 'Retry',
  'action.import': 'Import',
  'action.export': 'Export',
  'action.download': 'Download',
  'action.install': 'Install',
  'action.uninstall': 'Uninstall',
  'action.play': 'Play',
  'action.pause': 'Pause',
  'action.resume': 'Resume',
  'action.stop': 'Stop',
  'action.copy': 'Copy',
  'action.open': 'Open',
  'action.choose': 'Choose',
  'action.change': 'Change',
  'action.manage': 'Manage',
  'action.viewAll': 'View all',
  'lib.status.wishlist': 'Wishlist',
  'lib.status.notStarted': 'To play',
  'lib.status.inProgress': 'In progress',
  'lib.status.completed': 'Completed',
  'lib.status.abandoned': 'Abandoned',
  'dl.queued': 'Queued',
  'dl.downloading': 'Downloading',
  'dl.paused': 'Paused',
  'dl.completed': 'Completed',
  'dl.error': 'Error',
  'settings.general': 'General',
  'settings.appearance': 'Appearance',
  'settings.personalisation': 'Personalization',
  'settings.downloads': 'Downloads',
  'settings.debrid': 'Debrid services',
  'settings.account': 'Account',
  'settings.notifications': 'Notifications',
  'settings.integrations': 'Integrations',
  'settings.advanced': 'Advanced',
  'settings.privacy': 'Privacy',
  'settings.about': 'About',
  'common.loading': 'Loading…',
  'common.noResults': 'No results',
  'common.error': 'Error',
  'common.success': 'OK',
  'common.unknown': 'Unknown',
  'common.never': 'Never',
  'common.yes': 'Yes',
  'common.no': 'No',
}

const STRINGS: Record<LocaleId, Partial<Record<keyof typeof FR, string>>> = {
  fr: FR,
  en: EN,
}

let currentLocale: LocaleId = 'fr'

export function setLocale(locale: LocaleId): void {
  currentLocale = locale
  try {
    localStorage.setItem('nexus.locale', locale)
  } catch {
    /* no localStorage — fall back to in-memory */
  }
}

export function getLocale(): LocaleId {
  return currentLocale
}

/** Resolve the active locale from localStorage at module load. */
try {
  const saved = localStorage.getItem('nexus.locale')
  if (saved === 'fr' || saved === 'en') currentLocale = saved
} catch {
  /* ignore */
}

export type TranslationKey = keyof typeof FR

export function t(key: TranslationKey): string {
  return STRINGS[currentLocale]?.[key] ?? FR[key] ?? key
}
