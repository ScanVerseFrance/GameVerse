#!/usr/bin/env python3
"""
Convert `data/ankergames-index.json` (rich, 2-level mirror of the comics
tracker shape) into `data/ankergames-source.json` — the Hydra-style
JsonSource shape that GameVerse's "Importer un JSON" expects:

    {
      "name": "AnkerGames",
      "downloads": [
        {
          "title": "Forza Horizon 5",
          "uris": ["https://ankergames.net/game/forza-horizon-5"],
          "uploadDate": "2021-11-09",
          "fileSize": "166.6 GB"
        },
        ...
      ]
    }

Why the URI is the AnkerGames page URL: the real mirror URLs (Direct +
Torrent) are returned by a Livewire RPC that needs an authenticated
session, so we can't bake them into a public index. Putting the page URL
in `uris` gives the user a working "open the source page" affordance —
the launcher renders it in the download source picker, the user clicks
through to AnkerGames, signs in, and grabs the magnet/direct link.

Run from the repo root:
    python scripts/build-ankergames-jsonsource.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
SRC = REPO_ROOT / "data" / "ankergames-index.json"
OUT = REPO_ROOT / "data" / "ankergames-source.json"


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found — run ankergames_indexer.py first.", file=sys.stderr)
        return 1

    index = json.loads(SRC.read_text(encoding="utf-8"))
    downloads: list[dict] = []
    skipped = 0

    for slug, builds in index.items():
        # `builds` is the inner map: { "<slug>__build_<version>": {…} }
        # Today every game has exactly one build, but the shape is ready
        # for multi-build games. We emit one JsonSource entry per build.
        for build_key, b in builds.items():
            title = b.get("title")
            url = b.get("url")
            if not title or not url:
                skipped += 1
                continue
            # Build entry conditionally — Zod's `.optional()` accepts
            # `undefined` (i.e. key absent) but rejects `null`, so we must
            # OMIT missing fields rather than emit them as null.
            entry: dict = {"title": title, "uris": [url]}
            # Keep the most informative date: dateModified > datePublished.
            # The launcher shows this as "Sortie : <date>" in the UI.
            upload_date = b.get("dateModified") or b.get("datePublished")
            if upload_date:
                entry["uploadDate"] = upload_date
            file_size = b.get("fileSize")
            if file_size:
                entry["fileSize"] = file_size
            downloads.append(entry)

    # Stable ordering: alphabetical by title makes the in-app list pleasant.
    downloads.sort(key=lambda d: d["title"].lower())

    payload = {
        "name": "AnkerGames",
        "downloads": downloads,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"Wrote {OUT}")
    print(f"  → {len(downloads)} downloads ({size_mb:.2f} MB), {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
