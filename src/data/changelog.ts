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
    version: '0.3.3',
    date: '2026-05-20',
    title: 'PC Scanner + Stats parité ScanVerse + 13 thèmes + custom covers',
    highlights: [
      'Scanner PC: import auto Steam + cracks détectés dans HydraLauncher/Games',
      'Bouton Resynchroniser en haut-droite de la Bibliothèque + auto au 1er boot',
      'Steam games lancés via steam://rungameid/<appid> + logo Steam sur la tile',
      'Stats tab refondu : parité totale avec ScanVerse (12 cartes/graphes)',
      '13 thèmes builtins + Midnight Blue par défaut OOTB',
      'Covers personnalisables : fichier local ou URL, dans Propriétés',
      'Profil d\'un ami enfin accessible (was "Not found") + push avatar au cloud',
    ],
    changes: [
      // === PC Scanner ===
      { kind: 'feat', text: 'Scanner PC complet : parser VDF/ACF maison qui lit libraryfolders.vdf + appmanifest_*.acf de Steam, skip les redistribuables (228980, etc.), best-effort exe detection pour le achievement watcher. Fallback registry HKCU\\Software\\Valve\\Steam si Steam pas aux paths habituels.' },
      { kind: 'feat', text: 'Détection des cracks/repacks : scan heuristique de C:\\HydraLauncher, C:/Games, D:/Games, C:\\FitGirl Repacks, etc. Strip les suffixes "-SteamRIP.com", "[FitGirl Repack]", "(DODI)" pour un titre propre.' },
      { kind: 'feat', text: 'Wizard PcScanWizard : 4 phases (scanning → ready → importing → done), checkboxes par jeu, toggle global "Déplacer les cracks dans le dossier Nexus" (cut-paste atomique même disque, copy+rm cross-disk avec collision-safe suffix).' },
      { kind: 'feat', text: 'Auto first-boot : si library vide + sources détectées + jamais vu le wizard, ouvre auto une seule fois (localStorage flag).' },
      { kind: 'feat', text: 'Bouton Resynchroniser dans le header de la Bibliothèque pour relancer le scan à tout moment. Imports dédupés par sourceGameId — re-scan = idempotent.' },
      { kind: 'feat', text: 'Lancement Steam : sourceAddonId="steam" → shell.openExternal("steam://rungameid/<appid>") au lieu de spawn local. Steam gère DRM, playtime, achievements. Logo Steam à côté de Jouer sur la LibraryCard.' },
      // === Stats tab parité ScanVerse ===
      { kind: 'feat', text: 'Stats tab refondu en parité totale avec ScanVerse : 4 KPI cards (heures jouées, jeux joués, jours actifs, streak record), Rythme 7j vs moyenne 4 semaines, Heures de jeu préférées (24 bars), Jours de la semaine (7 bars), 30 derniers jours, Meilleur mois, Year-over-year compare, Le plus marathonné, Session la plus longue.' },
      { kind: 'feat', text: 'Single IPC profile:gameStats qui aggrège tout en un round-trip SQL contre play_sessions. Streak walker DST-safe.' },
      { kind: 'fix', text: 'Bars histogrammes invisibles quand 0 minute : zero-bars passent maintenant en baseline grise (--surface-medium) à 6px, bars > 0 en accent plein avec minimum 8%.' },
      // === Thèmes ===
      { kind: 'feat', text: '15 thèmes builtins (étaient 5) : Midnight Blue (nouveau défaut OOTB), Tokyo Night, Dracula, Cyberpunk, Ocean, Forest, Sunset, Crimson, Rose Gold, Mocha, Solarized Dark, Nord, Monochrome, Steam Dark, Nexus Light. Tous tunés sur le même système de surfaces pour rester lisibles.' },
      { kind: 'feat', text: 'Fallback theme robuste dans useApplyTheme : si le thème custom est supprimé alors qu\'il était actif, l\'app retombe sur Midnight Blue au lieu de rendre sans styles.' },
      // === Custom covers ===
      { kind: 'feat', text: 'Cover éditable depuis Propriétés → Général : bouton Fichier (OS picker, copie dans userData/custom-covers/<id>.<ext>) ou URL (validation https). Bouton Réinitialiser quand un override est actif. Badge "Perso" sur la jaquette.' },
      { kind: 'feat', text: 'Nouvelle colonne user_cover_url dans library_games + résolution prioritaire user_cover_url ?? cover_url dans rowToGame. L\'auto-resolver Steam/SGDB n\'écrit jamais sur l\'override.' },
      // === Cloud saves (suite v0.3.2) ===
      { kind: 'feat', text: 'SavesModal: status row en haut affiche Local: 6 Ko · 4 fichiers · modifié 20/05 (vert) ou Local: vide (rouge). Badge "= LOCAL" sur la version cloud qui matche le mtime local (fenêtre 60s), épinglée en position 0 dans la liste.' },
      { kind: 'feat', text: 'Cross-PC restore via Ludusavi redirects : détecte le username d\'origine dans mapping.yaml et écrit un redirect kind=restore dans config.yaml de Ludusavi. Idempotent.' },
      { kind: 'feat', text: 'Wipe local avant restore (Steam-style mirror) : Ludusavi preview pour découvrir les dossiers, rm -rf + mkdir, puis restore. Mods/backups perso disparaissent comme Steam Cloud.' },
      // === Notifications custom ===
      { kind: 'fix', text: 'Toasts custom Steam-style fonctionnent enfin : require(\'./toast-window.service\') lazy load échouait en build packagé ("Cannot find module"). Passage à import statique → toutes les notifs custom (download terminé, succès, message ami, ami lance un jeu, demande d\'ami) s\'affichent en bas-droite au lieu de la notification Windows native.' },
      { kind: 'feat', text: 'Download complete et achievement unlocked passent par pushToast avec cover/icon, plus de new Notification() native.' },
      // === Cloud connection ===
      { kind: 'fix', text: 'WebSocket cloud flicker à 1Hz résolu : openSocket bail si OPEN/CONNECTING (anti React StrictMode), open clear les reconnect timers en attente, stability window 5s avant reset du backoff. Heartbeat ping toutes les 30s pour outlast Traefik idle 60s.' },
      // === Library / friends ===
      { kind: 'fix', text: 'Exe manuel via Propriétés flippe maintenant le bouton "Télécharger" → "Jouer" : auto-backfill de install_path = path.dirname(exe) quand le row n\'avait pas d\'install_path.' },
      { kind: 'fix', text: 'Profil d\'un ami enfin accessible — getProfile query la table users locale qui ne contenait que self. Nouveau upsertCloudFriend qui mirror les friends récupérés du cloud (ON CONFLICT UPDATE pour préserver les FK).' },
      { kind: 'feat', text: 'Avatar/bio/displayName poussés au cloud après chaque update profil local → les autres users (liste d\'amis, profils) voient la mise à jour au prochain sync.' },
      // === Conflict dialog ===
      { kind: 'fix', text: 'Croix (X) top-right du SaveConflictDialog ferme juste le modal sans lancer le jeu. Le bouton Annuler en bas garde l\'ancien comportement (close + launch).' },
      { kind: 'fix', text: '"Garder local" envoie avec force=true → la garde anti-shrink ne skip plus silencieusement un choix explicite.' },
      // === Misc ===
      { kind: 'fix', text: 'Badge "Ctrl K" retiré de l\'input de recherche (le raccourci continue de marcher).' },
      { kind: 'polish', text: 'Logo Steam reprend la forme officielle Simple Icons (lens + orbites) — l\'ancien glyphe maison rendait flou aux petites tailles.' },
    ],
  },
  {
    version: '0.3.2',
    date: '2026-05-20',
    title: 'Sauvegardes cloud — gestionnaire complet + cross-PC + fixes flicker',
    highlights: [
      'Nouveau modal "Sauvegardes" : courante + 3 versions précédentes, restaurer / supprimer / forcer l\'envoi',
      'Restore cross-PC : ta save de djemo arrive bien dans PCTEST2/AppData/… via les redirects Ludusavi',
      'Anti-écrasement : si la save locale est nettement plus petite que le cloud, on bloque l\'upload',
      'Indicateur Local : badge "= LOCAL" sur la version cloud qui correspond à ton disque, sortie en haut de liste',
      'Cloud déco/reco toutes les secondes — réglé, plus de flicker du badge en haut',
      'Conflit au launch déclenché aussi sur le même PC (le bug qui t\'a fait perdre 20Ko)',
      'Backend : rétention auto à 4 versions par jeu (la plus récente + 3 backups)',
    ],
    changes: [
      // === SavesModal ===
      { kind: 'feat', text: 'Modal "Sauvegardes" sur la page jeu : liste les 4 versions cloud (rétention auto), boutons Restaurer / Supprimer par ligne, "Sauvegarder maintenant" en haut, "Ouvrir le dossier local" en footer.' },
      { kind: 'feat', text: 'Badge "DERNIÈRE CLOUD" (bleu) sur la version la plus récente uploadée et badge "= LOCAL" (vert) sur celle qui correspond exactement à ce qui est sur disque maintenant. La ligne matchée est épinglée en position 0.' },
      { kind: 'feat', text: 'Status row en haut du modal : "Local : 6 Ko · 4 fichiers · modifié 20/05 00:26" (vert) ou "Local : vide — aucun fichier de sauvegarde" (rouge). Plus de confusion sur ce qui est sur ton PC vs dans le cloud.' },
      { kind: 'feat', text: 'Bouton "Forcer l\'envoi" quand la garde anti-écrasement bloque — confirm dialog explicite avant d\'overwrite le cloud avec une save plus petite.' },
      // === Anti-écrasement ===
      { kind: 'feat', text: 'Garde anti-shrink avant chaque upload : si le tar local fait moins de 50% de la taille du dernier cloud, on bloque l\'upload, on remonte le snapshot cloud au renderer, et on laisse l\'utilisateur choisir Restaurer / Forcer.' },
      { kind: 'fix', text: 'Le toast après quit indique désormais "Save locale beaucoup plus petite que le cloud — Cloud 20Ko → local 6Ko. Cloud intact." au lieu d\'écraser silencieusement la version précédente.' },
      // === Conflict dialog ===
      { kind: 'fix', text: 'Le dialog de conflit au launch s\'ouvre maintenant dès que le cloud est plus récent que le local, même sur le même PC (la garde "fromDifferentHost" empêchait l\'avertissement quand tu effaçais des saves localement par erreur).' },
      { kind: 'fix', text: 'X en haut-droite du dialog de conflit ferme JUSTE le modal sans lancer le jeu. Le bouton "Annuler" en bas garde l\'ancien comportement (close + launch avec la save locale).' },
      { kind: 'fix', text: '"Garder local" envoie maintenant avec force=true — la garde anti-shrink ne peut plus skipper silencieusement un choix explicite de l\'utilisateur.' },
      // === Cross-PC restore ===
      { kind: 'feat', text: 'Restore cross-PC : avant chaque restore, le launcher détecte le username d\'origine dans mapping.yaml (C:/Users/djemo/…) et ajoute un redirect kind=restore dans le config.yaml de Ludusavi si ton user actuel diffère. Idempotent — un re-restore depuis la même machine source n\'ajoute pas de doublon.' },
      { kind: 'feat', text: 'Sémantique Steam-style : avant chaque restore, le dossier de save local est wipé (rm -rf + mkdir) puis Ludusavi écrit le snapshot. Les fichiers extras (mods, backups perso) disparaissent — le local devient un miroir exact du cloud.' },
      // === Backend ===
      { kind: 'feat', text: 'Backend : après chaque upload, le serveur purge les artifacts au-delà des 4 plus récents pour (shop, objectId). Best-effort post-commit — un échec de prune ne rollback pas l\'upload.' },
      { kind: 'feat', text: 'Permissions du volume cloud : le conteneur démarre en root, chown /var/nexus-cloud/saves vers node:node via docker-entrypoint.sh, puis drop privs via su-exec. Plus de 500 EACCES sur le POST /v1/saves/artifacts.' },
      // === WebSocket flicker ===
      { kind: 'fix', text: 'Cloud connect/disconnect en boucle à chaque seconde — réglé. openSocket() refuse de fermer une WS saine quand un appel parallèle arrive (React StrictMode double-mount). L\'event "open" annule tout timer de reconnect en attente. Stabilité 5s avant de reset le backoff.' },
      { kind: 'feat', text: 'Heartbeat ping toutes les 30s pour empêcher Traefik (et les autres reverse-proxies idle-timeout) de couper la WS au bout de 60s d\'inactivité.' },
      { kind: 'polish', text: 'Logs [cloud-ws] structurés (open / close / error / skip) pour diagnostiquer rapidement les futurs problèmes de connexion.' },
      // === Misc ===
      { kind: 'fix', text: 'Bug pré-existant : Ludusavi restore recevait notre objectId interne (jsg-…) au lieu du nom PCGamingWiki ("Geometry Dash"). Ludusavi répondait "No info for these games" et le restore échouait sur tous les jeux. Maintenant on passe ludusaviGameName(game.title) comme dans uploadGameSave.' },
      { kind: 'polish', text: 'previewBackup expose maintenant latestMtime (newest mtime des fichiers Ludusavi) pour permettre au modal de matcher local ↔ cloud sans relire le disque dans le renderer.' },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-05-19',
    title: 'Audit Nexus suite — avis étoilés + tendances + onglet Accueil retiré',
    highlights: [
      'Onglet Accueil supprimé — l\'app ouvre direct sur Découvrir',
      'Avis avec note 0-5 étoiles dorées + spoilers ||texte|| (style Discord)',
      'Carousels "Tendances", "Meilleurs jeux", "Pépites cachées" via Steam-250',
      'Bouton Aléatoire dans la nav top — surprise depuis tes catalogues',
      'Audio vs sous-titres distingués pour chaque langue',
      'Tooltips catégorie traduits FR (plus de "Steam Cloud", "Steam Achievements"…)',
      'Icône Trading Cards + 7 autres IDs manquants — SVG inline fallback',
    ],
    changes: [
      // === Reviews / Stars / Spoiler ===
      { kind: 'feat', text: 'Système d\'avis : composer avec note étoiles dorées 0-5 (StarRating), spoilers Discord ||texte|| cliquables pour révéler, parser tolérant aux ||markers|| non fermés.' },
      { kind: 'feat', text: 'Note moyenne agrégée par jeu (ratingSummary IPC) + histogramme distribution + bulk ratingSummariesBulk pour hydrater une grille en un round-trip.' },
      { kind: 'feat', text: 'Compteur de téléchargements total par jeu (LOCAL pour le moment — count des statuts completed dans la table downloads).' },
      { kind: 'breaking', text: 'Migration DB : ALTER TABLE game_comments ADD COLUMN rating — backfill à 0. Les anciens commentaires apparaissent maintenant comme avis sans note.' },
      // === Navigation ===
      { kind: 'feat', text: 'L\'app ouvre directement sur Découvrir au lancement. L\'onglet Accueil (doublon de Bibliothèque) est supprimé du top nav. Le router redirige / → /discover automatiquement.' },
      { kind: 'feat', text: 'Bouton "Aléatoire" dans le top nav (icône 🎲) → pick un jeu random parmi tes sources importées + navigate vers sa page. Désactivé silencieusement si aucune source.' },
      // === Steam-250 Discover ===
      { kind: 'feat', text: 'Carousels en haut de Découvrir : "Tendances" (top-100 derniers 15j), "Meilleurs jeux de la semaine" (best-of-year), "Pépites cachées". Couvers via Steam CDN library_600x900 avec fallback header.jpg.' },
      // === Icônes catégorie ===
      { kind: 'fix', text: 'Tooltips catégorie passent de "Steam Cloud / Steam Achievements / Steam Trading Cards" aux libellés Nexus FR ("Cloud", "Succès", "Cartes à échanger", "Sous-titres adaptés"…).' },
      { kind: 'feat', text: 'SVG inline fallback pour les 8 IDs Steam que steamdb.info/static/img/categories/ ne sert pas : Trading Cards (29), Stats (11/15), SDK (16), Mods (19), Leaderboards (25), Commentary (26), VR Collectibles (34).' },
      // === Languages audio/subs ===
      { kind: 'feat', text: 'Langues : distinction audio doublé vs sous-titres uniquement. Pastille verte ● pour les langues avec audio complet, pastille grise ○ pour sous-titres only. Légende inline.' },
      { kind: 'fix', text: 'Cache Steam meta bump (schema v3) → re-fetch automatique pour récupérer le champ languagesDetailed.' },
      // === HLTB et succès (rappel v0.3.0) ===
      { kind: 'polish', text: 'HLTB toujours live via /api/bleed reverse-engineering (Hollow Knight 27h, Spider-Man 2 17h, Elden Ring 60h, 14/15 jeux testés).' },
    ],
  },
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
