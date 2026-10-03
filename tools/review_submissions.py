#!/usr/bin/env python3
"""Review pending CheapBeer submissions and copy approved ones into prices.json.

Submissions wait PRIVATELY in the Workers KV namespace bound as SUBMISSIONS in
worker/wrangler.toml, and expire on their own after 90 days. Nothing reaches the
public price list until this script writes it into prices.json and that file is
committed and pushed by hand.

Usage, from the repository root:
  python3 tools/review_submissions.py                  list pending submissions
  python3 tools/review_submissions.py approve ID ...   copy into prices.json, then delete from KV
  python3 tools/review_submissions.py reject ID ...    delete from KV, publish nothing

ID is the last eight characters of a key, as the listing shows them, or the
whole key.

Options:
  --dry-run       show what would change; write and delete nothing
  --local         use wrangler's local KV store instead of the live one (testing)
  --prices PATH   price list to update (default: prices.json next to tools/)

How approve merges: a submission for a bar that is already listed (same bar
name and city, ignoring case) updates that row's glass size, price and date,
and fills its website if the row had none. Anything else becomes a new approved
row with an empty maps_url. Review `git diff prices.json` before committing.

Needs wrangler logged in to the Stormberry Cloudflare account, the same login
used to deploy the Worker. CHEAPBEER_WRANGLER overrides the command (default
"wrangler").
"""

import argparse
import datetime
import json
import os
import pathlib
import shlex
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"
BINDING = "SUBMISSIONS"
FIELDS = ("bar_name", "website", "address", "maps_url", "city",
          "size_l", "price_nok", "approved", "last_verified")


class Store:
    """The SUBMISSIONS namespace, reached through the wrangler CLI."""

    def __init__(self, local: bool):
        self.cmd = shlex.split(os.environ.get("CHEAPBEER_WRANGLER", "wrangler"))
        self.where = "--local" if local else "--remote"

    def _run(self, *args: str) -> str:
        env = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
        proc = subprocess.run([*self.cmd, "kv", "key", *args, "--binding", BINDING, self.where],
                              cwd=WORKER_DIR, env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit(f"wrangler kv key {args[0]} failed:\n{proc.stderr.strip() or proc.stdout.strip()}")
        return proc.stdout

    def keys(self) -> list[str]:
        out = self._run("list")
        return sorted(item["name"] for item in extract_json(out, "[", "the key list"))

    def get(self, key: str) -> dict:
        return extract_json(self._run("get", key, "--text"), "{", key)

    def delete(self, key: str) -> None:
        self._run("delete", key)


def extract_json(out: str, opener: str, what: str):
    """The JSON document in wrangler's stdout, skipping any banner lines."""
    closer = "]" if opener == "[" else "}"
    end = out.rfind(closer)
    offset = 0
    for line in out.splitlines(keepends=True):
        if line.lstrip().startswith(opener):
            try:
                return json.loads(out[offset:end + 1])
            except ValueError:
                pass
        offset += len(line)
    sys.exit(f"Could not read {what} from wrangler:\n{out.strip()}")


def short(key: str) -> str:
    return key.rsplit("-", 1)[-1]


def norm(text: str) -> str:
    return " ".join(str(text).split()).casefold()


def find_row(prices: list, sub: dict):
    for row in prices:
        if norm(row.get("bar_name", "")) == norm(sub["bar_name"]) and \
           norm(row.get("city", "")) == norm(sub["city"]):
            return row
    return None


def submitted_date(sub: dict) -> str:
    try:
        return datetime.datetime.fromisoformat(sub["submitted_at"].replace("Z", "+00:00")).date().isoformat()
    except (KeyError, ValueError):
        return datetime.date.today().isoformat()


def describe(key: str, sub: dict, prices: list) -> str:
    row = find_row(prices, sub)
    status = "new bar" if row is None else f"update, listed now at {row.get('size_l')} L {row.get('price_nok')} kr"
    lines = [f"{short(key)}  {submitted_date(sub)}  {sub['bar_name']}, {sub['city']}  "
             f"{sub['size_l']} L  {sub['price_nok']} kr  ({status})",
             f"          {sub['address']}"]
    if sub.get("website"):
        lines.append(f"          {sub['website']}")
    return "\n".join(lines)


def resolve(ids: list[str], keys: list[str]) -> list[str]:
    chosen = []
    for wanted in ids:
        hits = [k for k in keys if k == wanted or short(k) == wanted]
        if len(hits) != 1:
            sys.exit(f"{wanted}: {'no pending submission' if not hits else 'ambiguous'} with that ID")
        chosen.append(hits[0])
    return chosen


def merge(prices: list, sub: dict) -> str:
    date = submitted_date(sub)
    row = find_row(prices, sub)
    if row is not None:
        before = f"{row.get('size_l')} L {row.get('price_nok')} kr"
        row.update(size_l=sub["size_l"], price_nok=sub["price_nok"], approved=True, last_verified=date)
        if not row.get("website") and sub.get("website"):
            row["website"] = sub["website"]
        return f"updated {row['bar_name']}, {row['city']}: {before} -> {sub['size_l']} L {sub['price_nok']} kr"
    prices.append({
        "bar_name": sub["bar_name"],
        "website": sub.get("website", ""),
        "address": sub["address"],
        "maps_url": "",
        "city": sub["city"],
        "size_l": sub["size_l"],
        "price_nok": sub["price_nok"],
        "approved": True,
        "last_verified": date,
    })
    return f"added {sub['bar_name']}, {sub['city']}: {sub['size_l']} L {sub['price_nok']} kr (maps_url left empty)"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("action", nargs="?", choices=("list", "approve", "reject"), default="list")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--prices", type=pathlib.Path, default=ROOT / "prices.json")
    args = ap.parse_args()

    store = Store(args.local)
    prices = json.loads(args.prices.read_text(encoding="utf-8"))
    keys = store.keys()

    if args.action == "list":
        if not keys:
            print("No pending submissions.")
        for key in keys:
            print(describe(key, store.get(key), prices))
        return

    if not args.ids:
        sys.exit(f"{args.action}: give one or more IDs from the listing")
    chosen = resolve(args.ids, keys)
    prefix = "[dry run] " if args.dry_run else ""

    if args.action == "approve":
        for key in chosen:
            print(prefix + merge(prices, store.get(key)))
        if not args.dry_run:
            # The price list is written first, so a failed delete can only
            # leave a submission pending twice, never lose an approval.
            args.prices.write_text(json.dumps(prices, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for key in chosen:
        if not args.dry_run:
            store.delete(key)
        print(f"{prefix}deleted {short(key)} from the pending store")
    if args.action == "approve" and not args.dry_run:
        print(f"\n{args.prices.name} updated. Check `git diff {args.prices.name}`, fill any empty maps_url, then commit and push.")


if __name__ == "__main__":
    main()
