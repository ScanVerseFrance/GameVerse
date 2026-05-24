#!/usr/bin/env python3
"""
cFinder full-catalog indexer.

cFinder (https://cfinder.xyz/jeux) is a French crack site with ~2000
titles. The majority ship with the OnlineFix patch ALREADY MERGED —
recognisable from the version suffix `-OFME` (Online-Fix Multiplayer
Edition) or `+ Online`. That makes it the cleanest single-source for
"je veux le jeu + le multi en un click" which is exactly what the user
asked for.

Crawl strategy :
    /jeux?p=1, p=2, … N      (16 games per page, ~125 pages)
    /jeux/<id>-<slug>        (detail page per game)

Output :

    {
      "<slug>": {                                # outer key — game slug
        "<slug>__<id>": {                        # inner key — cfinder id
          "url": "https://cfinder.xyz/jeux/2885-forza-horizon-6",
          "downloadUrl": "https://directory.cfinder.xyz/index.php?id=2885",
          "title": "Forza Horizon 6",
          "version": "v360.259 -OFME",            # raw version label
          "onlineFix": true,                      # version mentions OFME/Online
          "cfId": 2885,
          "steamAppid": 2483190,                  # parsed from trailer URL
          "description": "Découvrez les paysages …",
          "cover": "https://cfinder.xyz/uploads/ForzaHorizon6.png",
          "screenshots": ["https://shared.akamai.steamstatic.com/…"],
          "trailerUrl": "https://video.akamai.steamstatic.com/…",
          "fileSize": null,                       # site doesn't list it
          "fileSizeBytes": null,
          "fetchedAt": 1763385123
        }
      }
    }

Resumable : re-running picks up where it left off ; `--force` to refresh.

Usage :
    python cfinder_indexer.py
    python cfinder_indexer.py --limit 30        # smoke test
    python cfinder_indexer.py --force --workers 4
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DATA_DIR = REPO_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
INDEX_PATH = DATA_DIR / "cfinder-index.json"

ROOT = "https://cfinder.xyz"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
    "Referer": ROOT + "/jeux",
}
TIMEOUT = 25
RETRY = 4
RETRY_BACKOFF = 3.0
MAX_PAGES = 200  # safety cap — ~125 actuels mais on garde du flou

# Throttling : cfinder fait du Cloudflare et tolère pas le burst sans
# limites. 600ms entre listing requests + worker concurrency limit.
LISTING_INTER_PAGE_DELAY = 0.6


# ────────────────────────── helpers ──────────────────────────


def fetch(url: str, *, session: requests.Session) -> str | None:
    """GET avec retry. cfinder est en UTF-8 partout, pas besoin de
    décodage explicite — on laisse requests deviner via Content-Type."""
    for attempt in range(RETRY):
        try:
            r = session.get(url, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200:
                r.encoding = r.encoding or "utf-8"
                return r.text
            if r.status_code in (429, 503):
                wait = float(r.headers.get("Retry-After", RETRY_BACKOFF * (2 ** attempt)))
                time.sleep(min(wait, 60))
                continue
            if 400 <= r.status_code < 500:
                return None
        except requests.RequestException:
            pass
        time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None


SLUG_RE = re.compile(r"^/jeux/(\d+)-([a-z0-9\-]+)/?$", re.IGNORECASE)


def parse_game_url(url: str) -> tuple[int, str] | None:
    """Extract (cf_id, slug) from /jeux/<id>-<slug>."""
    p = urlparse(url)
    m = SLUG_RE.match(p.path)
    if not m:
        return None
    return int(m.group(1)), m.group(2)


def title_from_slug(slug: str) -> str:
    """Convert URL slug to a human title — best effort. Stops words
    stay lowercase except in first position, roman numerals upper. """
    skip = {"and", "of", "the", "in", "on", "to", "for", "a", "an", "de", "du", "des"}
    parts = slug.split("-")
    out: list[str] = []
    for i, p in enumerate(parts):
        if not p:
            continue
        if re.fullmatch(r"[ivxlcdm]+", p, re.IGNORECASE) and len(p) <= 4:
            out.append(p.upper())
        elif i > 0 and p.lower() in skip:
            out.append(p.lower())
        else:
            out.append(p.capitalize())
    return " ".join(out)


# ────────────────────────── extractors ──────────────────────────


def extract_meta(html: str, prop: str) -> str | None:
    """Match either property= or name= meta."""
    for attr in ("property", "name"):
        m = re.search(
            rf'<meta\s+{attr}=["\']{re.escape(prop)}["\']\s+content=["\']([^"\']+)["\']',
            html,
            re.IGNORECASE,
        )
        if m:
            return m.group(1)
        # Inverted attribute order — cfinder mixes them
        m = re.search(
            rf'<meta\s+content=["\']([^"\']+)["\']\s+{attr}=["\']{re.escape(prop)}["\']',
            html,
            re.IGNORECASE,
        )
        if m:
            return m.group(1)
    return None


def extract_h1_titr(html: str) -> tuple[str | None, str | None]:
    """Pull the title + version label from `<h1 id="titr">Title <span class="version">…</span></h1>`."""
    m = re.search(
        r'<h1[^>]*id=["\']titr["\'][^>]*>([\s\S]*?)</h1>',
        html,
        re.IGNORECASE,
    )
    if not m:
        return None, None
    inner = m.group(1)
    # Extract the version span before stripping tags
    vm = re.search(
        r'<span[^>]*class=["\']version["\'][^>]*>([\s\S]*?)</span>',
        inner,
        re.IGNORECASE,
    )
    version = vm.group(1).strip() if vm else None
    # Strip tags + whitespace for the title
    title = re.sub(r"<[^>]+>", "", inner).strip()
    if version:
        title = title.replace(version, "").strip()
    return title or None, version


def extract_description(html: str) -> str | None:
    m = re.search(
        r'<p[^>]*id=["\']dcs["\'][^>]*>([\s\S]*?)</p>',
        html,
        re.IGNORECASE,
    )
    if not m:
        # Schema.org JSON-LD fallback
        ld = re.search(
            r'<script[^>]*application/ld\+json[^>]*>([\s\S]*?)</script>',
            html,
            re.IGNORECASE,
        )
        if ld:
            try:
                data = json.loads(ld.group(1))
                if isinstance(data, dict) and isinstance(data.get("description"), str):
                    return data["description"].strip()
            except json.JSONDecodeError:
                pass
        return None
    return re.sub(r"<[^>]+>", "", m.group(1)).strip() or None


def extract_steam_appid(html: str) -> int | None:
    """Parse the steamstatic trailer URL embedded in the detail page :
        store_trailers/<appid>/...
       and the screenshot URL :
        steam/apps/<appid>/...
    """
    for re_pattern in (
        r"store_trailers/(\d+)/",
        r"steam/apps/(\d+)/",
    ):
        m = re.search(re_pattern, html)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                continue
    return None


def extract_screenshots(html: str) -> list[str]:
    """Pull steamstatic screenshot URLs from the carousel block."""
    out: list[str] = []
    seen: set[str] = set()
    for m in re.finditer(
        r'<img[^>]*class=["\']slide["\'][^>]*src=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    ):
        u = m.group(1)
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def extract_trailer(html: str) -> str | None:
    m = re.search(
        r'<source[^>]*src=["\']([^"\']*steamstatic[^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    return m.group(1) if m else None


def extract_download_url(html: str) -> str | None:
    """The TELECHARGER button : <a href="https://directory.cfinder.xyz/index.php?id=N">."""
    m = re.search(
        r'href=["\'](https?://directory\.cfinder\.xyz/[^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    return m.group(1) if m else None


ONLINE_VERSION_RE = re.compile(
    r"\b(?:OFME|online[-\s]?fix|\+\s*online)\b",
    re.IGNORECASE,
)


def has_online_fix(version: str | None) -> bool:
    if not version:
        return False
    return bool(ONLINE_VERSION_RE.search(version))


# ────────────────────────── crawl ──────────────────────────


def list_listing_urls(session: requests.Session) -> list[str]:
    """Walk /jeux?p=1..N and collect all unique game URLs. Stops as soon
    as a page returns zero NEW URLs (end of catalog)."""
    seen: set[str] = set()
    out: list[str] = []
    for page in range(1, MAX_PAGES + 1):
        if page > 1:
            time.sleep(LISTING_INTER_PAGE_DELAY)
        url = f"{ROOT}/jeux" if page == 1 else f"{ROOT}/jeux?p={page}"
        html = fetch(url, session=session)
        if not html:
            break
        page_urls = re.findall(
            r'href=["\'](/jeux/\d+-[a-z0-9\-]+)["\']',
            html,
            re.IGNORECASE,
        )
        new_count = 0
        for u in page_urls:
            full = ROOT + u
            if full in seen:
                continue
            seen.add(full)
            out.append(full)
            new_count += 1
        if page % 5 == 0 or page == 1:
            print(f"  page {page} → {len(out)} unique URLs so far", flush=True)
        if new_count == 0:
            break
    return out


def build_entry(url: str, html: str) -> dict | None:
    parsed = parse_game_url(url)
    if not parsed:
        return None
    cf_id, slug = parsed

    h1_title, version = extract_h1_titr(html)
    title = h1_title or extract_meta(html, "og:title") or title_from_slug(slug)
    # cfinder met souvent "— Crack PC | cFinder" en suffixe sur og:title ;
    # on coupe à la première barre verticale ou tiret cadratin.
    if title:
        title = re.split(r"\s*[—|]\s*", title)[0].strip()

    description = extract_description(html) or extract_meta(html, "og:description")
    cover = extract_meta(html, "og:image")
    steam_appid = extract_steam_appid(html)
    screenshots = extract_screenshots(html)
    trailer = extract_trailer(html)
    download_url = extract_download_url(html)
    online_fix = has_online_fix(version)

    return {
        "url": url,
        "downloadUrl": download_url,
        "title": title,
        "version": version,
        "onlineFix": online_fix,
        "cfId": cf_id,
        "steamAppid": steam_appid,
        "description": description,
        "cover": cover,
        "screenshots": screenshots,
        "trailerUrl": trailer,
        "fileSize": None,
        "fileSizeBytes": None,
        "fetchedAt": int(time.time()),
    }


def build_key(slug: str, cf_id: int) -> str:
    return f"{slug}__{cf_id}"


def crawl_one(url: str, session: requests.Session) -> tuple[str, str, dict] | None:
    parsed = parse_game_url(url)
    if not parsed:
        return None
    cf_id, slug = parsed
    html = fetch(url, session=session)
    if not html:
        return None
    entry = build_entry(url, html)
    if not entry:
        return None
    return slug, build_key(slug, cf_id), entry


def merge_into_index(
    index: dict[str, dict[str, dict]], slug: str, key: str, entry: dict
) -> None:
    bucket = index.setdefault(slug, {})
    bucket[key] = entry


# ────────────────────────── CLI ──────────────────────────


def load_existing() -> dict:
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"WARN: {INDEX_PATH.name} corrupt — starting fresh", file=sys.stderr)
    return {}


def save(index: dict) -> None:
    """Atomic save with retry. Windows file-replace can fail when another
    process holds the target open for a few ms. Retry up to 5×."""
    tmp = INDEX_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    for attempt in range(5):
        try:
            tmp.replace(INDEX_PATH)
            return
        except PermissionError:
            time.sleep(0.4 * (attempt + 1))
    tmp.replace(INDEX_PATH)


def already_indexed(index: dict, url: str) -> bool:
    parsed = parse_game_url(url)
    if not parsed:
        return False
    _, slug = parsed
    return bool(index.get(slug))


def iter_pending(urls: Iterable[str], index: dict, force: bool) -> list[str]:
    if force:
        return list(urls)
    return [u for u in urls if not already_indexed(index, u)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--save-every", type=int, default=25)
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update(HEADERS)

    print("Listing /jeux pages …")
    urls = list_listing_urls(session)
    print(f"  → {len(urls)} unique game URLs across all pages")

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
                slug, key, entry = result
                merge_into_index(index, slug, key, entry)
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
