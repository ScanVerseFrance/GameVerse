/**
 * Central changelog data, exposed as a typed const so the UI can
 * iterate it and the TypeScript compiler catches malformed entries.
 *
 * Authoring rules
 * ---------------
 * - One entry per shipped version (no draft / unreleased entries —
 *   if it's in here, the bundle that exports it ships that version).
 * - Newest first. `version` MUST match `__NEXUS_VERSION__` so the
 *   "what's new" popup's lastSeenVersion comparison works.
 * - `highlights` is the top 1-3 callout features rendered in a hero
 *   block at the top of the entry. Keep them short — one line.
 * - `changes` is the full list, categorised by kind:
 *     • feat     — new feature / capability
 *     • polish   — UX refinement, perf, layout
 *     • fix      — bug fix
 *     • breaking — needs user action (data migration, settings reset)
 *
 * When a user goes from v0.2.X to v0.2.Y the popup shows every entry
 * with `version > lastSeenVersion`, oldest first so they read in
 * release order.
 */

export type ChangelogKind = 'feat' | 'polish' | 'fix' | 'breaking'

export interface ChangelogChange {
  kind: ChangelogKind
  text: string
}

export interface ChangelogEntry {
  version: string
  date: string
  title?: string
  highlights?: string[]
  changes: ChangelogChange[]
}

/**
 * Compare two semver-like "X.Y.Z" strings. Returns:
 *   > 0  if a > b
 *   < 0  if a < b
 *   = 0  if equal
 *
 * We don't pull semver as a dep — our versions are always plain
 * 0.X.Y triplets so a tuple compare suffices.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.0',
    date: '2026-05-19',
    title: 'Audit Hydra complet — HLTB v2 + 11 nouvelles features',
    highlights: [
      'HLTB enfin debloqué via le nouveau /api/bleed reverse-engineerée',
      'Succès complets sur Spider-Man 2 (et tous les gros titres) via g_rgAchievements JSON',
      '4 services debrid : Real-Debrid / All-Debrid / TorBox / Premiumize',
      'Modes & manette à droite avec icônes style SteamDB',
      'Hardware vs Steam requirements : badge "Ton PC tient les minimums"',
      'Common Redist installer (VCRedist 2013/2015-2022, .NET 4.8, DirectX)',
      '5 presets de thème + i18n base (FR/EN)',
    ],
    changes: [
      // === HLTB ===
      { kind: 'feat', text: 'HLTB v2 — reverse-engineering complet du nouveau /api/bleed (token + honey-pot triplet). Le proxy backend sur nexus.scanverse.online retourne maintenant les durées Main/Plus/100% pour TOUS les jeux (Hollow Knight 27h, Elden Ring 60h, Spider-Man 2 17h, #BLUD 9h…).' },
      { kind: 'fix', text: 'Cache HLTB côté backend : 5 min pour la triplette auth + 7j par titre. POST /v1/hltb/reset pour vider sans redeploy.' },
      // === Succès ===
      { kind: 'feat', text: "Tier 1 nouveau dans le scrape : extraction du JSON g_rgAchievements embarqué dans la page Steam community (full schema avec icônes + descriptions + hidden flag, indépendamment des changements HTML)." },
      { kind: 'feat', text: 'Tier 3 nouveau : fallback GetGlobalAchievementPercentagesForApp v2 (keyless) — retourne tous les api_names même quand le scrape community échoue.' },
      { kind: 'fix', text: 'Cache achievements_catalog wipé au boot de v0.3.0 (schema bump v2). Spider-Man 2 et autres gros titres affichent maintenant la centaine de succès au lieu du top-10 storefront fallback.' },
      { kind: 'polish', text: 'Sidebar limite à 10 succès + bouton "Voir tous les succès · N" qui ouvre un modal avec la grille complète 3 colonnes.' },
      { kind: 'fix', text: 'Icônes succès : toujours afficher la couleur + filter CSS grayscale quand verrouillé (Steam a supprimé `_gray.jpg` pour la plupart des titres post-2020). Plus de wall de Trophy SVG.' },
      // === Modes & Manette / Langues ===
      { kind: 'feat', text: 'Block "Modes & Manette" déplacé dans le sidebar droite, rendu en strip d\'icônes monochrome style SteamDB (indexé par Steam category id stable, 9 tones).' },
      { kind: 'feat', text: 'Badge "Online required" / "Offline OK" calculé à partir du mix des catégories multi.' },
      { kind: 'fix', text: 'Cache Steam meta bump (schema v2) → invalide les anciens entries qui avaient languages: [] à cause du parser <br> cassé. Les langues réapparaissent au prochain affichage.' },
      // === Debrid services ===
      { kind: 'feat', text: 'Real-Debrid : magnet → ready (poll 60s) → unrestrict link → URL HTTPS directe. Auth via Bearer token.' },
      { kind: 'feat', text: 'All-Debrid : magnet upload → status poll → files → unlock. Détection auto compte non-premium.' },
      { kind: 'feat', text: 'TorBox : createtorrent → mylist poll → requestdl. Choisit le plus gros fichier.' },
      { kind: 'feat', text: 'Premiumize : /transfer/directdl en une seule call (plus simple). Choisit le plus gros lien.' },
      { kind: 'feat', text: 'pingProvider() valide la clé API + détecte le statut premium pour chaque service.' },
      // === Source dedup / Search ===
      { kind: 'fix', text: 'Recherche "spider-" matche maintenant "Spider Man" ET "Spider-Man" — tokenisation alphanumérique au lieu d\'un LIKE littéral.' },
      { kind: 'fix', text: 'Apostrophes stripées en lecture SQL : "marvels" matche "Marvel\'s Spider-Man".' },
      { kind: 'feat', text: 'Source dedup préfère AnkerGames (preinstall) sur FitGirl (repack) quand les éditions sont égales — bonus +1.0 dans le scoring.' },
      { kind: 'fix', text: 'Tightened cross-source dedup : strip MULTi[N], "Selective Download", "From X GB", tags qualité (HQ Audio, 4K, HDR), tags région (WW, EU, NA), tags release (PROPER, INTERNAL, RIP).' },
      // === DownloadConfirmDialog source picker ===
      { kind: 'feat', text: 'Sélecteur de source dans le dialog de téléchargement : quand un jeu existe dans 2+ catalogues, choisir la variante avant install. Taille/titre/verdict disque se recalculent à la sélection.' },
      // === Catalog auto-refresh ===
      { kind: 'feat', text: 'Re-fetch périodique des catalogues JSON (6h par défaut, configurable). Inserts seulement les nouveautés, jamais delete — préserve les favoris si l\'upstream rebuild.' },
      { kind: 'feat', text: 'Boot delay 30s avant le premier tick. POST IPC pour refresh manuel.' },
      // === Hardware compat ===
      { kind: 'feat', text: 'Détection automatique CPU/RAM/GPU (Win32_VideoController via wmic + PowerShell fallback).' },
      { kind: 'feat', text: 'Parser Steam pc_requirements HTML → OS/CPU/RAM/GPU/VRAM/Storage. Verdict per-dimension (pass/warn/fail/unknown) + worst-case overall.' },
      { kind: 'feat', text: 'Badge "Ton PC dépasse les recommandations" / "Tient les minimums" / "Limite" / "Insuffisant" inline dans la card Configuration requise.' },
      // === Common Redist ===
      { kind: 'feat', text: 'Détecte les runtimes installés via registry (HKLM Uninstall, 32+64 bit) : VC++ 2013/2015-2022 x86/x64, .NET 4.8, DirectX.' },
      { kind: 'feat', text: 'Download silencieux depuis aka.ms + install /quiet /norestart. Treat exit 3010 + 1638 comme success.' },
      // === Power save / process watcher ===
      { kind: 'feat', text: 'Power Save Blocker : reference-counted par download actif, libéré à pause/fin/erreur. Windows ne dort plus pendant les FitGirl 65 GB.' },
      { kind: 'feat', text: 'External Process Watcher (opt-in) : poll tasklist toutes les 5s, détecte les launches Steam/Epic/standalone hors Nexus, cumule playtime.' },
      // === Notifications inbox ===
      { kind: 'feat', text: 'Table SQLite notifications avec kinds (download_complete, achievement_unlocked, friend_request, message, etc.), prune 90j, cap 500/user.' },
      // === Steam-250 ===
      { kind: 'feat', text: 'Tire 5 listes curated depuis steam-250.com (top-100 2-weeks, hidden gems, best-of-year, most-played, top-250) avec cache 24h.' },
      // === Themes ===
      { kind: 'feat', text: '5 presets de thème (ScanVerse Sombre, Minuit Noir, Verdant, Crimson, Oceanic) avec CSS variables sur :root. Persisté localStorage.' },
      // === i18n ===
      { kind: 'feat', text: 'Framework i18n base : t("key") avec 60+ clés extraites (nav, actions, statuses, dl states, settings). FR par défaut, EN prêt.' },
      // === Misc UX ===
      { kind: 'feat', text: 'Game properties dialog redesigné en sidebar style Hydra avec 5 tabs (Général, Emplacements, Fichiers, Statistiques, Zone dangereuse).' },
      { kind: 'feat', text: 'Bouton "Jouer" devient "Télécharger" sur la home + library card quand le jeu n\'est pas installé. Navigation vers la page source.' },
      { kind: 'feat', text: 'SourcePicker persistent dans la sidebar — affiche TOUTES les variantes peu importe la page sur laquelle on est.' },
      { kind: 'feat', text: 'Big Picture mode déjà câblé : bouton dans top nav toggle fullscreen + kiosk + always-on-top.' },
      { kind: 'breaking', text: 'Cache succès wipé au boot — chaque jeu re-fetch son schéma au prochain affichage (~1s par jeu). One-time.' },
    ],
  },
  {
    version: '0.2.14',
    date: '2026-05-18',
    title: 'Audit Hydra : traduction + Cmd+K',
    highlights: [
      'Bouton "Traduire" sur chaque review (Google Translate proxy)',
      'Palette de recherche globale Ctrl+K (bibliothèque + catalogues + amis)',
    ],
    changes: [
      { kind: 'feat', text: "Traduction inline des reviews avec détection auto de la langue source. Cache mémoire — 2e clic instantané." },
      { kind: 'feat', text: 'Command palette Stremio-style ouverte par Ctrl/Cmd+K. Cherche en parallèle dans les 3 sources, navigation clavier complète.' },
    ],
  },
  {
    version: '0.2.13',
    date: '2026-05-18',
    title: 'Install/uninstall enfin propres',
    highlights: [
      "Réinstall manuelle sans crash quand le launcher tourne",
      'Désinstallation Windows avec UI custom',
    ],
    changes: [
      { kind: 'fix', text: "Le wizard Setup.exe taskkille le launcher en cours avant d'écraser. Plus de crash EBUSY sur réinstall manuelle." },
      { kind: 'feat', text: 'Apps & features → Désinstaller ouvre maintenant une mini-fenêtre custom dark accent rose, opt-in "supprimer aussi mes données".' },
      { kind: 'polish', text: "UninstallString repointé vers le launcher avec --uninstall (le détour cmd.exe foirait sur Win11). QuietUninstallString garde le legacy script pour winget/MDM." },
    ],
  },
  {
    version: '0.2.12',
    date: '2026-05-18',
    title: 'UX toast de mise à jour',
    changes: [
      { kind: 'polish', text: "Toast de MAJ passe de 6s à 5 min — t'as le temps de cliquer." },
      { kind: 'fix', text: "Click sur toast de MAJ ré-ouvre la popup d'update au lieu de te jeter sur /settings." },
      { kind: 'fix', text: "Version en bas à droite (StatusBar) lit la vraie valeur au lieu d'afficher v0.1.0 hardcodé." },
    ],
  },
  {
    version: '0.2.11',
    date: '2026-05-18',
    title: 'Toasts d\'amis enfin réparés',
    highlights: [
      "Les toasts message + ami-lance-jeu apparaissent enfin",
      'Mode silence (snooze) + journal diagnostique',
    ],
    changes: [
      { kind: 'fix', text: "Handshake renderer-ready pour la fenêtre de toast : main queue les payloads pendant le mount React, drain dès que le listener est en place. Le 1er toast d'ami ne se perdait plus." },
      { kind: 'fix', text: "friend:request lisait data.fromUser au lieu de data.from (mismatch contrat serveur)." },
      { kind: 'feat', text: 'Mode silence dans Paramètres → Notifications : 15min / 1h / 4h. Mute tout sauf les MAJ critiques. Compteur live.' },
      { kind: 'feat', text: 'Journal diagnostique : trace en direct du pipeline WS + toasts, accessible depuis Paramètres ou Ctrl+Shift+I.' },
      { kind: 'feat', text: 'Tri de la bibliothèque : Joué récemment / Ajouté récemment / A-Z / Temps de jeu. Persisté.' },
    ],
  },
  {
    version: '0.2.10',
    date: '2026-05-18',
    changes: [
      { kind: 'fix', text: 'Big Picture : la barre de hints clavier ne cache plus le bouton "Quitter B.P." de la sidebar.' },
    ],
  },
  {
    version: '0.2.9',
    date: '2026-05-18',
    changes: [
      { kind: 'fix', text: "Fond opaque autour des toasts corrigé (body.toast-overlay force le fond transparent)." },
      { kind: 'polish', text: 'Cartes de toast un peu plus compactes, avatar 48 → 40px, layout plus proche de Steam.' },
    ],
  },
  {
    version: '0.2.8',
    date: '2026-05-18',
    title: 'Toasts Steam-style in-app',
    highlights: [
      "Fini les toasts Windows natifs — on dessine les nôtres",
      'Fonctionne launcher minimisé ou pendant un jeu plein écran',
    ],
    changes: [
      { kind: 'feat', text: "Fenêtre flottante always-on-top transparente en bas-droit de l'écran, avatar + cover + accent par type. Mode DND Windows n'a plus d'effet." },
      { kind: 'polish', text: "Hover pour pause le timer, click pour focus + nav vers la page concernée." },
    ],
  },
]

/** Entries strictly newer than `lastSeenVersion`, oldest first so
 *  they read in release order. */
export function getUnseenEntries(lastSeenVersion: string | null): ChangelogEntry[] {
  if (!lastSeenVersion) {
    // First-ever boot — show only the topmost entry as a welcome
    // teaser, not the whole history.
    return CHANGELOG.length > 0 ? [CHANGELOG[0]!] : []
  }
  return CHANGELOG
    .filter((e) => compareVersions(e.version, lastSeenVersion) > 0)
    .slice()
    .reverse()
}
