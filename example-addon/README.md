# Addon Nexus de démonstration — Jeux Open Source

Addon de démo au format Nexus listant **5 vrais jeux open source légalement gratuits**, depuis leurs sites officiels. Tu peux les télécharger via Nexus, les installer et y jouer.

| Jeu | Genre | Taille | Source |
|-----|-------|--------|--------|
| OpenRA | RTS (remake Command & Conquer) | ~115 Mo | GitHub releases |
| Mindustry | Tower defense + factory | ~140 Mo | GitHub releases |
| 0 A.D. | RTS antiquité | ~1.3 Go | playOAD.com |
| SuperTuxKart | Karting | ~850 Mo | GitHub releases |
| Battle for Wesnoth | Stratégie fantasy tour-par-tour | ~450 Mo | wesnoth.org |

## Lancement

Depuis ce dossier :

```bash
python -m http.server 8000
```

Ou double-clique `serve.bat` sous Windows.

## Installation dans Nexus

1. Lance Nexus (`npm run dev` à la racine du projet)
2. Connecte-toi ou clique **Continuer en invité**
3. Sidebar → **Addons** → **Installer addon**
4. Colle :
   ```
   http://localhost:8000/manifest.json
   ```
5. Clique **Installer**

L'addon s'installe. Va dans **Découvrir** : les 5 jeux apparaissent. Clique sur l'un d'eux → page détail avec description, screenshots, sources. Clique **Télécharger** sur une source HTTP → le download démarre dans le manager Nexus, progress bar live.

## Ce que ça démontre

- Validation Zod du manifeste à l'installation
- Endpoint `catalog` → liste de jeux dans **Découvrir**
- Endpoint `meta` (`/games/:id.json`) → page détail enrichie
- Endpoint `download` (`/downloads/:id.json`) → sources HTTP
- Cache local (TTL 60s) — édite un JSON, attends 1 min, refresh
- Genres déclarés dans le manifeste → filter chips dans Découvrir
- Téléchargement HTTP réel end-to-end (streaming + progress + pause/resume)

## Notes

Les URLs de download pointent vers des releases officielles. Si une release est retirée par les éditeurs, l'URL peut renvoyer 404 — édite simplement le `downloads/<jeu>.json` pour pointer vers une release plus récente, le cache se rafraîchit en 60s.

Les URLs de cover/screenshot pointent vers Wikipedia Commons ou les sites officiels. Si une image ne charge pas, la carte affiche l'icône fallback — ça ne casse rien.

## Format du manifeste

Voir `manifest.json`. Schéma résumé :

```typescript
{
  id: string              // ID unique reverse-DNS recommandé
  name: string
  version: string
  contentType: "games"
  endpoints: {
    catalog: string       // OBLIGATOIRE
    meta?: string         // :id est remplacé par l'ID du jeu
    download?: string
    search?: string
    featured?: string
  }
  catalogs: [{
    id: string
    name: string
    genres?: string[]
    sortable?: boolean
  }]
  description?, author?, homepage?, iconUrl?: string
  cacheTtlSeconds?: number  // 0-86400, défaut 3600
}
```
