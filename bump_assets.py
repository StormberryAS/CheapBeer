#!/usr/bin/env python3
"""Stamp a content hash onto the cache-busting query string of local assets.

Why this exists
---------------
Cloudflare serves these files with `cache-control: max-age=14400` and the
filenames never change, so a deploy is invisible to returning visitors and to
the edge for hours. It is worse than the four hours suggests: on 2026-09-04 an
app.js was measured at `age: 35067`, nearly ten hours, still `cf-cache-status:
HIT`, long past its own TTL. A purge does not help either, because it clears
Cloudflare but never a browser.

The query string IS part of the Cloudflare cache key on this zone (verified by
a MISS/HIT/MISS probe), so bumping ?v= busts the edge and the browser at once.

Keying on the file's own SHA-256 means a run that changes nothing produces no
diff, so this is safe to run before every commit and impossible to forget to
bump.

What it does NOT touch, deliberately:
  * anything under switcher-icons/ - those bytes never change, and the marquee
    repeats them 180 times, so stamping them would bloat the HTML for nothing
  * absolute URLs - not ours to version
  * font files referenced from inside a CSS file - the CSS gets a new ?v= when
    it changes, and the font bytes are immutable anyway

Usage:  python3 bump_assets.py [--check]
        --check exits 1 if any page is stale, without writing. For a git hook.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SKIP_DIRS = {"switcher-icons", "node_modules", ".git", "android", "dist", "fastlane"}
ASSET_RE = re.compile(r'(?P<attr>src|href)="(?P<path>(?!https?://|//|data:|#|mailto:)[^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"')


def pages():
    out = []
    for p in sorted(ROOT.rglob("*.html")):
        if SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        out.append(p)
    return out


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def main() -> None:
    check_only = "--check" in sys.argv
    cache: dict[str, str] = {}
    stale, seen = [], set()

    for page in pages():
        text = page.read_text(encoding="utf-8")

        def repl(m: re.Match) -> str:
            rel = m.group("path")
            target = (page.parent / rel).resolve()
            if not target.is_file() or ROOT.resolve() not in target.parents and target.parent != ROOT.resolve():
                return m.group(0)          # points outside the repo, leave alone
            if SKIP_DIRS & set(target.relative_to(ROOT.resolve()).parts):
                return m.group(0)
            key = str(target)
            if key not in cache:
                cache[key] = digest(target)
            seen.add(target.relative_to(ROOT.resolve()).as_posix())
            return f'{m.group("attr")}="{rel}?v={cache[key]}"'

        updated = ASSET_RE.sub(repl, text)
        if updated != text:
            stale.append(page.relative_to(ROOT).as_posix())
            if not check_only:
                page.write_text(updated, encoding="utf-8")

    for rel in sorted(seen):
        print(f"{rel:<28} v={cache[str((ROOT / rel).resolve())]}")
    if stale:
        print(f"{len(stale)} page(s) {'stale' if check_only else 'updated'}: {', '.join(stale)}")
    else:
        print("all pages already current")

    if check_only and stale:
        sys.exit(1)


if __name__ == "__main__":
    main()
