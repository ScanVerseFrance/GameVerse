#!/usr/bin/env python3
"""
Convert `data/cfinder-index.json` into `data/cfinder-source.json`
(Hydra-style JsonSource shape that GameVerse imports).

cFinder's actual download URL is `https://directory.cfinder.xyz/index.php?id=<id>`
which is a redirect/intermediate page (the user clicks TELECHARGER and
the actual download mirror is resolved server-side, likely behind a
captcha or a delay). We emit BOTH :

  • the cFinder page URL (so the user sees the game info + description)
  • the directory redirect URL (the actual "download" affordance)

The user clicks the source in our DownloadConfirmDialog → opens the
cFinder page → clicks TELECHARGER there → goes to the directory page →
gets the mirror. Not zero-click but it's the standard cFinder flow.

Run from the repo root :
    python scripts/build-cfinder-jsonsource.py
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
SRC = REPO_ROOT / "data" / "cfinder-index.json"
OUT = REPO_ROOT / "data" / "cfinder-source.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--online-only",
        action="store_true",
        help="Émettre seulement les jeux dont la version contient OFME / OnlineFix.",
    )
    args = ap.parse_args()

    if not SRC.exists():
        print(f"ERROR: {SRC} not found — run cfinder_indexer.py first.", file=sys.stderr)
        return 1

    index = json.loads(SRC.read_text(encoding="utf-8"))
    downloads: list[dict] = []
    skipped = 0
    online_count = 0

    for slug, builds in index.items():
        for key, b in builds.items():
            title = b.get("title")
            url = b.get("url")
            if not title or not url:
                skipped += 1
                continue
            is_online = bool(b.get("onlineFix"))
            if args.online_only and not is_online:
                continue

            entry: dict = {"title": title}
            # uris : directory URL en premier (c'est la VRAIE action de
            # téléchargement), puis la page cFinder comme fallback /
            # "voir le jeu en détail". L'user voit dans la dialog
            # "1ère URL = download direct, 2nde = info".
            uris: list[str] = []
            if b.get("downloadUrl"):
                uris.append(b["downloadUrl"])
            uris.append(url)
            entry["uris"] = uris
            if is_online:
                online_count += 1
            downloads.append(entry)

    downloads.sort(key=lambda d: d["title"].lower())

    payload = {
        "name": "cFinder" + (" (Online)" if args.online_only else ""),
        "downloads": downloads,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"Wrote {OUT}")
    print(
        f"  → {len(downloads)} downloads ({size_mb:.2f} MB), "
        f"{skipped} skipped, {online_count} flagged Online-Fix"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
