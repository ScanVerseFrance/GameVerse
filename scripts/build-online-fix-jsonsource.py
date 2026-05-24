#!/usr/bin/env python3
"""
Convert `data/online-fix-index.json` into the Hydra-style JsonSource
shape that GameVerse's "Importer un JSON" expects.

v0.5.1 — Important fact about online-fix.me : each post has FOUR
download buttons :

    1. "Скачать с Online-Fix Hosters"   → FULL GAME (hosters.*)
    2. "Скачать с Online-Fix Drive"     → FULL GAME (drive.*)
    3. "Скачать фикс с сервера"         → fix patch ALONE (uploads/uploads/)
    4. "Скачать Torrent"                 → FULL GAME (uploads/torrents/)

So online-fix is a VALID full-game source. The previous build emitted
the post URL only and labelled the entry "Patch online" — that was
wrong. We now emit the THREE full-game URLs (Hosters / Drive / Torrent)
as the `uris[]`, ordered torrent-first because it's the most stable
mirror long-term. The patch-only URL is dropped.

Output :

    {
      "name": "Online-Fix",
      "downloads": [
        {
          "title": "Forza Horizon 6",
          "uris": [
            "https://uploads.online-fix.me:2053/torrents/Forza Horizon 6/",
            "https://hosters.online-fix.me:2053/Forza Horizon 6",
            "https://drive.online-fix.me:2053/Forza Horizon 6"
          ],
          "uploadDate": "2026-05-15"
        }, ...
      ]
    }

When a post has NO full-game mirror (rare — old fix-only posts), we
fall back to the post URL so the user still gets a path to download
the patch manually.

Use `--post-url-only` to revert to the v0 behaviour (post URL only,
user opens browser).

Run from the repo root :
    python scripts/build-online-fix-jsonsource.py
    python scripts/build-online-fix-jsonsource.py --post-url-only
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
SRC = REPO_ROOT / "data" / "online-fix-index.json"
OUT = REPO_ROOT / "data" / "online-fix-source.json"


def iso_to_date(s: str | None) -> str | None:
    """Trim 'YYYY-MM-DDTHH:MM:SS+TZ' → 'YYYY-MM-DD' for the launcher UI."""
    if not s:
        return None
    return s[:10] if len(s) >= 10 and s[4] == "-" and s[7] == "-" else s


def categorize_host_urls(host_urls: list[str]) -> tuple[list[str], list[str]]:
    """Sort the mirror URLs into (full_game, patch_only) buckets.

    Online-fix hostnames :
      • hosters.online-fix.me            → full game
      • drive.online-fix.me              → full game
      • uploads.online-fix.me/torrents/  → full game (torrent)
      • uploads.online-fix.me/uploads/   → patch only (fix files)

    The torrent path is the most STABLE mirror long-term (no expiring
    direct links, no CDN throttle), so we emit it first when present.
    """
    full_game: list[str] = []
    patch_only: list[str] = []
    torrents: list[str] = []
    hosters: list[str] = []
    drives: list[str] = []
    import re
    for u in host_urls:
        # uploads.* — match BEFORE the others because it has 2 paths.
        if "uploads.online-fix.me" in u:
            if "/torrents/" in u:
                torrents.append(u)
            elif "/uploads/" in u:
                patch_only.append(u)
            else:
                # Unknown uploads subpath — be safe, treat as patch.
                patch_only.append(u)
        elif re.search(r"://hosters\.online-fix\.me", u, re.IGNORECASE):
            hosters.append(u)
        elif re.search(r"://drive\.online-fix\.me", u, re.IGNORECASE):
            drives.append(u)
    # Order: torrent (most stable) → hosters (direct, fastest) → drive (backup)
    full_game.extend(torrents)
    full_game.extend(hosters)
    full_game.extend(drives)
    return full_game, patch_only


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--post-url-only",
        action="store_true",
        help="Legacy v0 behaviour : emit only the post URL, user picks the mirror manually.",
    )
    args = ap.parse_args()

    if not SRC.exists():
        print(f"ERROR: {SRC} not found — run online_fix_indexer.py first.", file=sys.stderr)
        return 1

    index = json.loads(SRC.read_text(encoding="utf-8"))
    downloads: list[dict] = []
    skipped = 0
    no_mirror_fallback = 0

    for slug, builds in index.items():
        for build_key, b in builds.items():
            title = b.get("title")
            url = b.get("url")
            if not title or not url:
                skipped += 1
                continue

            entry: dict = {"title": title}

            if args.post_url_only:
                # v0 mode — just the post URL.
                entry["uris"] = [url]
            else:
                # Default mode — full-game URLs first, fallback to post.
                full_game, _patch = categorize_host_urls(b.get("hostUrls") or [])
                if full_game:
                    entry["uris"] = full_game
                else:
                    # Aucun mirror full-game extrait — vieux post fix-only
                    # OU scrape incomplet. On retombe sur la page post pour
                    # ne pas perdre l'entry.
                    entry["uris"] = [url]
                    no_mirror_fallback += 1

            upload_date = iso_to_date(b.get("dateModified")) or iso_to_date(
                b.get("datePublished")
            )
            if upload_date:
                entry["uploadDate"] = upload_date
            file_size = b.get("fileSize")
            if file_size:
                entry["fileSize"] = file_size
            downloads.append(entry)

    downloads.sort(key=lambda d: d["title"].lower())

    payload = {
        "name": "Online-Fix",
        "downloads": downloads,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"Wrote {OUT}")
    print(f"  → {len(downloads)} downloads ({size_mb:.2f} MB), {skipped} skipped")
    if args.post_url_only:
        print(f"  → uri mode: post URL only (legacy)")
    else:
        print(
            f"  → uri mode: full-game mirrors (torrent → hosters → drive), "
            f"{no_mirror_fallback} entries fell back to post URL"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
