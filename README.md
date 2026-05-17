# GameVerse / Nexus Launcher

Plugin-neutral game launcher built on Electron 33 + React 18 + TypeScript strict.
Part of the SVU (ScanVerse Universe) family.

## Highlights

- **Plugin-neutral catalogue** — sources are external; the launcher itself ships zero hard-coded storefronts. Import JSON catalogues (Hydra-style) at runtime, install HTTP add-ons, or run the AnkerGames bridge for headless installs.
- **Hydra-style achievement detection** — polls Goldberg / CODEX / OnlineFix / EMPRESS / SKIDROW / RUNE / RLD! / CreamAPI save folders every 2 s while a game is running. Toast pops in the bottom-right the moment a new achievement is written.
- **Full Steam achievement schema** — keyless scrape of the Steam community page, so even the long tail (Geometry Dash's 100+ achievements) shows up without an API key.
- **Steam-style library** — playtime tracking, "currently playing" indicator, auto-detected executable, ZIP extraction (yauzl + ZSTD via fzstd), launch options, integrity verification, install/uninstall.
- **ScanVerse-style profile** — banner + avatar + plaque + decoration + profile effect + YouTube music embed. Per-section privacy gating (public/friends/invisible) with a master toggle.
- **Discord-style presence** — online/in_game/away/offline dots with last-seen, automatic transitions on focus / blur / idle / game launch / exit.
- **Friend launch toast** — when a friend on the same machine starts a game, a Steam-style card slides in with cover art + game title.
- **SQLite persistence** — single `nexus-launcher.db` in Electron's userData path. `better-sqlite3` for the speed; migrations are idempotent column-adds.

## Stack

- **Main process**: Electron 33, `better-sqlite3`, `webtorrent`, `yauzl`, `fzstd`
- **Renderer**: React 18, React Router v6 (HashRouter), Zustand, Tailwind, Framer Motion
- **Build**: Vite + `vite-plugin-electron`, `electron-builder` for packaging

## Run locally

```bash
npm install
npm run dev          # Vite dev server + Electron, with HMR for both
npm run build        # Type-check + production renderer bundle
npm run package      # electron-builder bundle for the host OS
```

## Status

Pre-1.0 internal build. The UI is French-only for now; i18n is on the roadmap.
