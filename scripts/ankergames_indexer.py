#!/usr/bin/env python3
"""
AnkerGames full-catalog indexer.

Writes `data/ankergames-index.json` (resolved relative to the GameVerse
repo root, so the script can be invoked from anywhere). Mirrors the
two-level layout of the comics tracker (`{ series: { tome: {…} } }`) →
here `{ game_slug: { game_slug__build_<version>: {…} } }`:

    {
      "<game_slug>": {                        # outer key — game (≈ series)
        "<game_slug>__build_<version>": {     # inner key — build (≈ tome)
          "url": "https://ankergames.net/game/<slug>",
          "title": "Forza Horizon 5",
          "version": "21856128",
          "downloadLink": null,               # gated behind login on the site
          "hostIds": [16],                    # mirrors revealed in HTML
          "fileSize": "166.6 GB",
          "fileSizeBytes": 178843381760,
          "datePublished": "2021-11-09",
          "dateModified": "2026-02-26",
          "cover": "https://ankergames.net/uploads/...",
          "screenshots": [...],
          "trailer": "https://www.youtube.com/embed/...",
          "description": "Your Ultimate Horizon Adventure...",
          "genres": ["Adventure", "Open World", "Racing"],
          "developer": "Playground Games",
          "platform": "PC",
          "operatingSystem": "Windows",
          "playMode": "SinglePlayer",         # 'SinglePlayer'|'MultiPlayer'|'CoOp'
          "downloads": 322837,
          "rating": 5.0,
          "ratingCount": 10,
          "softwareRequirements": "...",
          "fetchedAt": 1763385123
        }
      },
      ...
    }

Resumable: re-running picks up where it left off. Pass `--force` to
re-crawl entries we already have (e.g. to refresh stale data).

Usage:
    python ankergames_indexer.py                # crawl missing entries
    python ankergames_indexer.py --limit 25     # smoke-test a slice
    python ankergames_indexer.py --force        # full re-crawl
    python ankergames_indexer.py --workers 8    # parallelism (default 6)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import requests

# Windows cp1252 console can't render the arrow / bullet glyphs we print.
# Force UTF-8 once, here, so the rest of the script can stay readable.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover — older Pythons / non-TTY pipes
    pass

HERE = Path(__file__).resolve().parent
# Index lives in `data/` at the repo root so it sits next to other data
# artefacts and is easy to ship/load from the renderer if needed later.
REPO_ROOT = HERE.parent
DATA_DIR = REPO_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
INDEX_PATH = DATA_DIR / "ankergames-index.json"

SITEMAP_INDEX = "https://ankergames.net/sitemap.xml"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Referer": "https://ankergames.net/games-list",
}
TIMEOUT = 25
RETRY = 5
RETRY_BACKOFF = 4.0  # seconds — base; multiplied by attempt count


# ────────────────────────── helpers ──────────────────────────


def fetch(url: str, *, session: requests.Session) -> str | None:
    """GET with retry/backoff. Returns body text on success or None.

    On 429/503 we back off aggressively (exponential, doubling per try)
    because AnkerGames throttles after a short burst — the polite thing
    is to slow way down rather than hammer with the next worker.
    Genuine 4xx (404 deleted game, 403 region-blocked) bail out fast."""
    for attempt in range(RETRY):
        try:
            r = session.get(url, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.text
            if r.status_code in (429, 503):
                # Honour Retry-After when present, otherwise grow the wait
                wait = float(r.headers.get("Retry-After", RETRY_BACKOFF * (2 ** attempt)))
                time.sleep(min(wait, 60))
                continue
            if 400 <= r.status_code < 500:
                return None  # 404/403 — no point retrying
        except requests.RequestException:
            pass
        time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None


def parse_size_to_bytes(size: str | None) -> int | None:
    """Convert '166.6 GB' / '512 MB' / '1.2 TB' → bytes (binary multipliers)."""
    if not size:
        return None
    m = re.match(
        r"^\s*([\d.,]+)\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB|B)\s*$",
        size.strip(),
        re.IGNORECASE,
    )
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    unit = m.group(2).upper().rstrip("IB") + "B"  # 'GiB' → 'GB', etc.
    mult = {
        "B": 1,
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
    }[unit]
    return int(n * mult)


def slug_from_url(url: str) -> str | None:
    """Extract '<slug>' from 'https://ankergames.net/game/<slug>'."""
    p = urlparse(url)
    if not p.path.startswith("/game/"):
        return None
    slug = p.path[len("/game/"):].strip("/")
    return slug or None


def first_jsonld(html: str) -> dict | None:
    m = re.search(
        r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("@type") == "VideoGame":
                return item
        return None
    return data if isinstance(data, dict) else None


def collect_host_ids(html: str) -> list[int]:
    return sorted({int(x) for x in re.findall(r"generateDownloadUrl\((\d+)\)", html)})


def normalise_playmode(value: Any) -> str | list[str] | None:
    """Schema.org `playMode` is a string for SP-only games but a LIST for
    games that flag both modes (`["https://schema.org/SinglePlayer",
    "https://schema.org/MultiPlayer"]`). Normalise both shapes: scalar
    stays scalar, list returns the list with the URL prefix stripped."""
    if not value:
        return None
    if isinstance(value, str):
        return value.rsplit("/", 1)[-1]
    if isinstance(value, list):
        return [v.rsplit("/", 1)[-1] for v in value if isinstance(v, str)] or None
    return None


def actor_to_developer(actor: Any) -> str | None:
    if not actor:
        return None
    if isinstance(actor, list):
        names = [a.get("name") for a in actor if isinstance(a, dict)]
        return ", ".join(n for n in names if n) or None
    if isinstance(actor, dict):
        return actor.get("name")
    return None


def safe_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def safe_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ────────────────────────── core ──────────────────────────


def load_sitemap_urls(session: requests.Session) -> list[str]:
    """Walk the AnkerGames sitemap index and return every /game/<slug> URL."""
    body = fetch(SITEMAP_INDEX, session=session)
    if not body:
        print("ERROR: cannot fetch sitemap index", file=sys.stderr)
        return []
    subsitemaps = re.findall(r"<loc>([^<]+sitemap_post_\d+\.xml)</loc>", body)
    urls: list[str] = []
    for sm in subsitemaps:
        sm_body = fetch(sm, session=session)
        if not sm_body:
            print(f"WARN: failed to fetch sub-sitemap {sm}", file=sys.stderr)
            continue
        urls.extend(re.findall(r"<loc>(https://ankergames\.net/game/[^<]+)</loc>", sm_body))
    # Dedupe while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            unique.append(u)
    return unique


def build_entry(url: str, html: str) -> dict | None:
    """Turn one game page into a build-entry dict. Returns None on parse failure."""
    g = first_jsonld(html)
    if not g:
        return None

    file_size = g.get("fileSize")
    return {
        "url": url,
        "title": g.get("name"),
        "version": g.get("softwareVersion"),
        # downloadLink stays null — the actual mirror URL is returned by an
        # authenticated Livewire RPC. We expose hostIds so a consumer can
        # tell how many mirrors exist and which generator id to call when
        # logged in.
        "downloadLink": None,
        "hostIds": collect_host_ids(html),
        "fileSize": file_size,
        "fileSizeBytes": parse_size_to_bytes(file_size),
        "datePublished": g.get("datePublished"),
        "dateModified": g.get("dateModified"),
        "cover": g.get("image"),
        "screenshots": g.get("screenshot") or [],
        "trailer": (g.get("trailer") or {}).get("embedUrl") if isinstance(g.get("trailer"), dict) else None,
        "description": g.get("description"),
        "genres": g.get("genre") or [],
        "developer": actor_to_developer(g.get("actor")),
        "platform": g.get("gamePlatform"),
        "operatingSystem": g.get("operatingSystem"),
        "playMode": normalise_playmode(g.get("playMode")),
        "downloads": safe_int((g.get("interactionStatistic") or {}).get("userInteractionCount"))
            if isinstance(g.get("interactionStatistic"), dict)
            else None,
        "rating": safe_float((g.get("aggregateRating") or {}).get("ratingValue"))
            if isinstance(g.get("aggregateRating"), dict)
            else None,
        "ratingCount": safe_int((g.get("aggregateRating") or {}).get("ratingCount"))
            if isinstance(g.get("aggregateRating"), dict)
            else None,
        "softwareRequirements": g.get("softwareRequirements"),
        "fetchedAt": int(time.time()),
    }


def build_key(slug: str, version: str | None) -> str:
    """Mirror the comics convention: outer key is the series slug, inner key
    is `<slug>__build_<version>` (falls back to `__main` when no version)."""
    suffix = f"build_{version}" if version else "main"
    return f"{slug}__{suffix}"


def crawl_one(url: str, session: requests.Session) -> tuple[str, dict] | None:
    slug = slug_from_url(url)
    if not slug:
        return None
    html = fetch(url, session=session)
    if not html:
        return None
    entry = build_entry(url, html)
    if not entry:
        return None
    return slug, entry


def merge_into_index(
    index: dict[str, dict[str, dict]], slug: str, entry: dict
) -> None:
    bucket = index.setdefault(slug, {})
    key = build_key(slug, entry.get("version"))
    bucket[key] = entry


# ────────────────────────── CLI ──────────────────────────


def load_existing() -> dict:
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"WARN: {INDEX_PATH.name} is corrupt — starting fresh", file=sys.stderr)
    return {}


def save(index: dict) -> None:
    tmp = INDEX_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(INDEX_PATH)


def already_indexed(index: dict, url: str) -> bool:
    slug = slug_from_url(url)
    if not slug:
        return False
    bucket = index.get(slug)
    return bool(bucket)


def iter_pending(urls: Iterable[str], index: dict, force: bool) -> list[str]:
    if force:
        return list(urls)
    return [u for u in urls if not already_indexed(index, u)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=None,
                    help="Only crawl the first N pending URLs (smoke test).")
    ap.add_argument("--force", action="store_true",
                    help="Re-crawl every URL even when already indexed.")
    ap.add_argument("--save-every", type=int, default=25,
                    help="Flush the JSON to disk after N successful entries.")
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update(HEADERS)

    print("Loading sitemap…")
    urls = load_sitemap_urls(session)
    print(f"  → {len(urls)} game URLs")

    index = load_existing()
    print(f"  → {sum(len(v) for v in index.values())} entries already on disk")

    pending = iter_pending(urls, index, args.force)
    if args.limit is not None:
        pending = pending[: args.limit]
    print(f"  → {len(pending)} pending to crawl")

    if not pending:
        print("Nothing to do.")
        return 0

    ok = 0
    fail = 0
    last_save = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(crawl_one, u, session): u for u in pending}
        for n, fut in enumerate(as_completed(futures), 1):
            url = futures[fut]
            try:
                result = fut.result()
            except Exception as e:  # noqa: BLE001
                print(f"  ! {url} → {e}", file=sys.stderr)
                result = None
            if result:
                slug, entry = result
                merge_into_index(index, slug, entry)
                ok += 1
            else:
                fail += 1
            if n % 10 == 0 or n == len(pending):
                elapsed = time.time() - started
                rate = n / elapsed if elapsed else 0
                eta = (len(pending) - n) / rate if rate else 0
                print(
                    f"  [{n}/{len(pending)}] ok={ok} fail={fail} "
                    f"rate={rate:.1f}/s eta={eta:.0f}s"
                )
            if ok - last_save >= args.save_every:
                save(index)
                last_save = ok

    save(index)
    print(f"Done. ok={ok} fail={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
