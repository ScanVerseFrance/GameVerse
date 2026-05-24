#!/usr/bin/env python3
"""
online-fix.me full-catalog indexer.

Mirror the ankergames workflow but adapted for online-fix.me, a Russian
site that publishes "fix" packages enabling LAN/online multiplayer on
games whose Steam edition normally requires Steamworks. Each post lives
under /games/<category>/<id>-<slug>-po-seti.html (the `-po-seti` suffix
means "online", left in the slug for compatibility — we strip it when
deriving the English title).

The site's sitemap.xml is decades-stale (last refreshed 2019), so we
crawl via the category listings + pagination instead:

    /games/officialservers/
    /games/officialservers/page/2/
    …
    /games/<other-category>/page/N/

Output structure (mirrors the ankergames index for parity):

    {
      "<slug>": {                              # outer key — game slug
        "<slug>__build_<version>": {           # inner key — build
          "url": "https://online-fix.me/games/officialservers/...html",
          "title": "Forza Horizon 6",          # derived from URL slug
          "titleRu": "Forza Horizon 6 по сети",# raw Russian h1
          "category": "officialservers",
          "postId": 18099,
          "version": "360.259",                # extracted from <b>Версия...
          "downloadLink": null,                # multi-mirror, see hosters
          "hostUrls": [                        # extracted download buttons
            "https://hosters.online-fix.me:2053/Forza Horizon 6",
            "https://drive.online-fix.me:2053/Forza Horizon 6",
            "https://uploads.online-fix.me:2053/torrents/Forza Horizon 6/"
          ],
          "fileSize": null,                    # rarely listed on the page
          "fileSizeBytes": null,
          "datePublished": "2026-05-15T07:00:32+03:00",
          "dateModified":  "2026-05-19T18:14:14+03:00",
          "cover": "https://img.youtube.com/...",  # og:image
          "trailer": "https://www.youtube-nocookie.com/embed/...",
          "fetchedAt": 1763385123
        }
      }
    }

Resumable: re-running picks up where it left off (skip slugs already
indexed unless --force).

Usage:
    python online_fix_indexer.py                 # crawl missing
    python online_fix_indexer.py --limit 25      # smoke test
    python online_fix_indexer.py --force         # full re-crawl
    python online_fix_indexer.py --workers 6     # default 4
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

# Force UTF-8 console — cp1252 Windows shells can't render the Cyrillic
# chars we occasionally print (titles, log lines).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DATA_DIR = REPO_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
INDEX_PATH = DATA_DIR / "online-fix-index.json"

ROOT = "https://online-fix.me"

# Categories observed on the homepage navigation. New ones can be added
# here — the listing crawler tolerates 404 gracefully so dropping a
# missing category just no-ops.
CATEGORIES = [
    "officialservers",
    "adventures",
    "arcade",
    "fighting",
    "horror",
    "puzzles",
    "racing",
    "rpg",
    "sandbox",
    "shooter",
    "simulator",
    "strategy",
    "survival",
    "vr",
]

# /coop/ is a separate top-level (not under /games/) — handled with a
# different listing path. Same structure otherwise.
COOP_PATH = "coop"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    # Accept Cyrillic — server defaults to windows-1251 but content-
    # negotiation here is meaningless ; the response always carries
    # the win1251 charset and we decode below.
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6,fr;q=0.5",
    "Referer": ROOT + "/",
}
TIMEOUT = 25
RETRY = 4
RETRY_BACKOFF = 3.0
MAX_PAGES_PER_CATEGORY = 40  # safety cap — most categories have < 20

# Polite throttling : online-fix.me starts returning empty bodies (silent
# rate-limit) after ~30 successive listing requests. A 700ms delay
# between LISTING pages + a 200ms inter-category gap keeps us under that
# threshold ; the per-page game crawl uses the ThreadPoolExecutor which
# self-throttles naturally via worker count.
LISTING_INTER_PAGE_DELAY = 0.7
LISTING_INTER_CATEGORY_DELAY = 1.5


# ────────────────────────── helpers ──────────────────────────


def fetch(url: str, *, session: requests.Session) -> str | None:
    """GET with retry. Returns decoded body (UTF-8 string) or None.

    Online-fix serves cp1251 ; we decode using the page's declared
    charset when present (meta http-equiv) else fall back to
    windows-1251 (the site default). We never trust requests'
    `r.text` because chardet sometimes guesses wrong on short bodies."""
    for attempt in range(RETRY):
        try:
            r = session.get(url, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200:
                # Try meta charset first, otherwise win1251.
                raw = r.content
                charset = "windows-1251"
                m = re.search(
                    rb'<meta[^>]*charset=["\']?([\w\-]+)',
                    raw[:4096],
                    re.IGNORECASE,
                )
                if m:
                    try:
                        charset = m.group(1).decode("ascii").lower()
                    except UnicodeDecodeError:
                        pass
                try:
                    return raw.decode(charset, errors="replace")
                except LookupError:
                    return raw.decode("windows-1251", errors="replace")
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


def parse_size_to_bytes(size: str | None) -> int | None:
    if not size:
        return None
    m = re.match(
        r"^\s*([\d.,]+)\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB|B|МБ|ГБ|КБ)\s*$",
        size.strip(),
        re.IGNORECASE,
    )
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    unit_raw = m.group(2).upper()
    # Russian aliases
    if unit_raw == "МБ":
        unit = "MB"
    elif unit_raw == "ГБ":
        unit = "GB"
    elif unit_raw == "КБ":
        unit = "KB"
    else:
        unit = unit_raw.rstrip("IB") + "B"  # 'GiB' → 'GB'
    mult = {
        "B": 1,
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
    }[unit]
    return int(n * mult)


# URL slug shape, both relative and absolute paths handled at call site.
# The trailing suffixes online-fix uses are inconsistent : `-po-seti`
# (по сети = "online"), `-online`, or none at all. Strip all of them
# so the derived English title is stable.
SLUG_RE = re.compile(
    r"^/(?:games/[^/]+|coop)/(\d+)-([a-z0-9\-]+?)(?:-(?:po-seti|online))?\.html$",
    re.IGNORECASE,
)


def slug_from_url(url: str) -> tuple[str, int] | None:
    """Extract (slug, post_id) from a game URL.

    The slug is the part between `<id>-` and the optional suffix tail
    (`-po-seti` or `-online`). Returns None when the URL doesn't match
    the expected shape (a category landing page or unrelated URL).
    """
    p = urlparse(url)
    m = SLUG_RE.match(p.path)
    if not m:
        return None
    post_id = int(m.group(1))
    slug = m.group(2).strip("-")
    if not slug:
        return None
    return slug, post_id


def title_from_slug(slug: str) -> str:
    """Convert a URL slug into a human-readable title — best effort.

    `forza-horizon-6` → `Forza Horizon 6`. Edge cases (Roman numerals,
    proper noun preservation) are good enough for searching against
    Steam — the launcher's title resolver does the fuzzy match anyway.
    """
    # Skip-words that should stay lowercase (Steam titles usually have
    # them lowercased too: "and", "of", "the" in mid-position). The
    # first word stays capitalised below.
    skip = {"and", "of", "the", "in", "on", "to", "for", "a", "an"}
    parts = slug.split("-")
    out: list[str] = []
    for i, p in enumerate(parts):
        if not p:
            continue
        # Roman numeral (II, III, IV…) → upper.
        if re.fullmatch(r"[ivxlcdm]+", p, re.IGNORECASE) and len(p) <= 4:
            out.append(p.upper())
        elif i > 0 and p.lower() in skip:
            out.append(p.lower())
        else:
            out.append(p.capitalize())
    return " ".join(out)


def extract_h1(html: str) -> str | None:
    m = re.search(
        r'<h1[^>]*id=["\']news-title["\'][^>]*>(.*?)</h1>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if not m:
        return None
    return re.sub(r"<[^>]+>", "", m.group(1)).strip() or None


def extract_meta(html: str, prop: str) -> str | None:
    m = re.search(
        rf'<meta\s+property=["\']{re.escape(prop)}["\']\s+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    return m.group(1) if m else None


def extract_dates(html: str) -> tuple[str | None, str | None]:
    pub = re.search(
        r'itemprop=["\']datePublished["\'][^>]*>([^<]+)<',
        html,
        re.IGNORECASE,
    )
    mod = re.search(
        r'itemprop=["\']dateModified["\'][^>]*>([^<]+)<',
        html,
        re.IGNORECASE,
    )
    return (
        pub.group(1).strip() if pub else None,
        mod.group(1).strip() if mod else None,
    )


def extract_version(html: str) -> str | None:
    """Pull the version string from `<b>Версия игры: X.Y.Z</b>` patterns."""
    m = re.search(
        r"Версия\s*игры:\s*</?b?>?\s*([^\s<]+)",
        html,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).strip().rstrip(".,;:")
    # English fallback
    m = re.search(r"Game\s*version:?\s*</?b?>?\s*([^\s<]+)", html, re.IGNORECASE)
    return m.group(1).strip().rstrip(".,;:") if m else None


def extract_youtube_id(html: str) -> str | None:
    m = re.search(
        r'youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_\-]{6,})',
        html,
    )
    return m.group(1) if m else None


def extract_host_urls(html: str) -> list[str]:
    """Extract the download mirror URLs from the post body.

    Online-fix exposes several mirrors per game inside `<a class="btn
    btn-success">` buttons — hosters.online-fix.me, drive.online-fix.me,
    uploads.online-fix.me. We dedup + sort for stable output.
    """
    seen: list[str] = []
    for m in re.finditer(
        r'href=["\']((?:https?:)?//[^"\']+online-fix\.me[^"\']*)["\']',
        html,
        re.IGNORECASE,
    ):
        u = m.group(1)
        if u.startswith("//"):
            u = "https:" + u
        # Strip URL fragments + skip non-download internal pages.
        if "#" in u:
            u = u.split("#", 1)[0]
        # Skip auth / forum / search pages — only keep host subdomains.
        if "/auth.php" in u or "/index.php" in u:
            continue
        if not re.search(
            r"://(?:hosters|drive|uploads|t)\.online-fix\.me",
            u,
            re.IGNORECASE,
        ):
            continue
        if u not in seen:
            seen.append(u)
    return seen


# ────────────────────────── crawl ──────────────────────────


def list_category_pages(category: str, session: requests.Session) -> list[str]:
    """Walk all pages of /games/<category>/ (or /coop/) and collect game URLs."""
    is_coop = category == COOP_PATH
    base = f"{ROOT}/{'coop' if is_coop else 'games/' + category}/"
    urls: list[str] = []
    seen: set[str] = set()
    for page in range(1, MAX_PAGES_PER_CATEGORY + 1):
        url = base if page == 1 else f"{base}page/{page}/"
        # Throttle BEFORE the request — even on page 1 of the 2nd+
        # category, so the inter-category gap is real.
        if page > 1:
            time.sleep(LISTING_INTER_PAGE_DELAY)
        body = fetch(url, session=session)
        if not body:
            break
        # Anchors to game pages — online-fix mixes absolute (full URL
        # with the https://online-fix.me prefix) and relative (`/games/
        # cat/...`) hrefs on the same page. Match both shapes via an
        # optional protocol+host prefix.
        prefix = "coop" if is_coop else f"games/{category}"
        page_urls = re.findall(
            rf'href=["\'](?:https?://online-fix\.me)?(/{prefix}/\d+-[^"\']+\.html)["\']',
            body,
            re.IGNORECASE,
        )
        if not page_urls:
            break
        new_count = 0
        for u in page_urls:
            # Strip URL fragments / query strings just in case.
            u = u.split("#", 1)[0].split("?", 1)[0]
            full = ROOT + u
            if full in seen:
                continue
            seen.add(full)
            urls.append(full)
            new_count += 1
        # If a page returns 0 NEW urls, we've hit the end (DLE often
        # echoes the same anchor list on out-of-range pages instead of
        # 404'ing).
        if new_count == 0:
            break
    return urls


def collect_all_game_urls(session: requests.Session) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for i, cat in enumerate(CATEGORIES + [COOP_PATH]):
        if i > 0:
            # Gap between catégories pour ne pas griller le serveur.
            time.sleep(LISTING_INTER_CATEGORY_DELAY)
        print(f"Listing /{cat}/ …", flush=True)
        urls = list_category_pages(cat, session)
        added = 0
        for u in urls:
            if u in seen:
                continue
            seen.add(u)
            out.append(u)
            added += 1
        print(f"  → {added} new ({len(urls)} total this category)", flush=True)
    return out


def build_entry(url: str, html: str) -> dict | None:
    parsed = slug_from_url(url)
    if not parsed:
        return None
    slug, post_id = parsed

    raw_title = extract_h1(html) or extract_meta(html, "og:title")
    en_title = title_from_slug(slug)
    pub, mod = extract_dates(html)
    cover = extract_meta(html, "og:image")
    yt = extract_youtube_id(html)
    trailer = f"https://www.youtube-nocookie.com/embed/{yt}" if yt else None
    host_urls = extract_host_urls(html)
    version = extract_version(html)
    # Category lives in the URL path /games/<category>/...
    p = urlparse(url).path
    cat_m = re.match(r"^/games/([^/]+)/", p)
    category = cat_m.group(1) if cat_m else ("coop" if p.startswith("/coop/") else None)

    return {
        "url": url,
        "title": en_title,
        "titleRu": raw_title,
        "category": category,
        "postId": post_id,
        "version": version,
        "downloadLink": None,
        "hostUrls": host_urls,
        # The site rarely lists a single fileSize (most posts are fix
        # patches not full games). Kept null for schema parity with
        # the ankergames index.
        "fileSize": None,
        "fileSizeBytes": None,
        "datePublished": pub,
        "dateModified": mod,
        "cover": cover,
        "trailer": trailer,
        "fetchedAt": int(time.time()),
    }


def build_key(slug: str, version: str | None) -> str:
    suffix = f"build_{version}" if version else "main"
    return f"{slug}__{suffix}"


def crawl_one(url: str, session: requests.Session) -> tuple[str, dict] | None:
    parsed = slug_from_url(url)
    if not parsed:
        return None
    slug, _ = parsed
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
    """Atomic save with retry. Windows file-replace can fail with
    PermissionError when another process (an editor, a `python -c
    cat`, an antivirus scan) holds the target open for a few ms. We
    retry up to 5× with a short backoff — long enough to ride out the
    common cases, short enough to not stall the crawl noticeably."""
    tmp = INDEX_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    for attempt in range(5):
        try:
            tmp.replace(INDEX_PATH)
            return
        except PermissionError:
            time.sleep(0.4 * (attempt + 1))
    # Last try — let the exception propagate if it still fails so we
    # see it in the logs rather than silently losing the batch.
    tmp.replace(INDEX_PATH)


def already_indexed(index: dict, url: str) -> bool:
    parsed = slug_from_url(url)
    if not parsed:
        return False
    slug, _ = parsed
    return bool(index.get(slug))


def iter_pending(urls: Iterable[str], index: dict, force: bool) -> list[str]:
    if force:
        return list(urls)
    return [u for u in urls if not already_indexed(index, u)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=None,
                    help="Only crawl the first N pending URLs (smoke test).")
    ap.add_argument("--force", action="store_true",
                    help="Re-crawl every URL even when already indexed.")
    ap.add_argument("--save-every", type=int, default=25,
                    help="Flush the JSON to disk after N successful entries.")
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update(HEADERS)

    print("Listing categories…")
    urls = collect_all_game_urls(session)
    print(f"  → {len(urls)} unique game URLs across all categories")

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
