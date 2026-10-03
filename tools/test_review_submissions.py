#!/usr/bin/env python3
"""Offline tests for review_submissions.py.  Run:  python3 tools/test_review_submissions.py

wrangler is replaced by a small fake that keeps the KV namespace in a JSON
file, so nothing here touches Cloudflare or the real prices.json.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE / "review_submissions.py"

FAKE_WRANGLER = textwrap.dedent('''
    import json, os, sys
    store = os.environ["FAKE_KV"]
    data = json.load(open(store))
    args = sys.argv[1:]
    assert args[:2] == ["kv", "key"], args
    assert "--binding" in args and args[args.index("--binding") + 1] == "SUBMISSIONS", args
    assert "--remote" in args, "the live store must be the default"
    verb = args[2]
    print("banner line with no JSON in it")
    if verb == "list":
        print(json.dumps([{"name": k} for k in data], indent=2))
    elif verb == "get":
        print(data[args[3]])
    elif verb == "delete":
        del data[args[3]]
        json.dump(data, open(store, "w"))
''')


def sub(bar, city, size, price, when="2026-10-02T10:15:00.000Z", website=""):
    return json.dumps({"bar_name": bar, "city": city, "address": f"{bar} street 1, 0182 {city}",
                       "website": website, "size_l": size, "price_nok": price, "submitted_at": when})


class ReviewTool(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = pathlib.Path(self.tmp.name)
        (tmp / "fake_wrangler.py").write_text(FAKE_WRANGLER)
        self.kv = tmp / "kv.json"
        self.kv.write_text(json.dumps({
            "sub-20261002T101500Z-aaaa1111": sub("Last Train", "oslo", 0.4, 79, website="https://new.example/"),
            "sub-20261002T101600Z-bbbb2222": sub("Testbaren", "Bergen", 0.5, 82),
            "sub-20261002T101700Z-cccc3333": sub("Spam", "Oslo", 0.5, 1),
        }))
        self.prices = tmp / "prices.json"
        self.original = [{
            "bar_name": "Last Train", "website": "", "address": "Storgata 39, 0182 Oslo",
            "maps_url": "https://maps.example/last-train", "city": "Oslo", "size_l": 0.5,
            "price_nok": 89, "approved": True, "last_verified": "",
        }]
        self.prices.write_text(json.dumps(self.original, indent=2, ensure_ascii=False) + "\n")
        self.env = {**os.environ, "FAKE_KV": str(self.kv),
                    "CHEAPBEER_WRANGLER": f"{sys.executable} {tmp / 'fake_wrangler.py'}"}

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args, ok=True):
        proc = subprocess.run([sys.executable, str(TOOL), *args, "--prices", str(self.prices)],
                              env=self.env, capture_output=True, text=True)
        if ok:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc

    def test_list_marks_updates_and_new_bars(self):
        out = self.run_tool().stdout
        self.assertIn("aaaa1111", out)
        self.assertIn("update, listed now at 0.5 L 89 kr", out)
        self.assertIn("Testbaren, Bergen  0.5 L  82 kr  (new bar)", out)

    def test_approve_updates_existing_row_and_adds_new_one(self):
        self.run_tool("approve", "aaaa1111", "sub-20261002T101600Z-bbbb2222")
        prices = json.loads(self.prices.read_text())
        self.assertEqual(len(prices), 2)
        last_train, testbaren = prices
        self.assertEqual((last_train["size_l"], last_train["price_nok"], last_train["last_verified"]),
                         (0.4, 79, "2026-10-02"))
        self.assertEqual(last_train["maps_url"], "https://maps.example/last-train", "reviewed fields kept")
        self.assertEqual(last_train["address"], "Storgata 39, 0182 Oslo", "reviewed address kept")
        self.assertEqual(last_train["website"], "https://new.example/", "empty website filled")
        self.assertEqual(list(testbaren), ["bar_name", "website", "address", "maps_url", "city",
                                           "size_l", "price_nok", "approved", "last_verified"])
        self.assertIs(testbaren["approved"], True)
        self.assertNotIn("submitted_at", testbaren)
        self.assertEqual(list(json.loads(self.kv.read_text())), ["sub-20261002T101700Z-cccc3333"])

    def test_reject_publishes_nothing(self):
        self.run_tool("reject", "cccc3333")
        self.assertEqual(json.loads(self.prices.read_text()), self.original)
        self.assertNotIn("sub-20261002T101700Z-cccc3333", json.loads(self.kv.read_text()))

    def test_dry_run_changes_nothing(self):
        before_kv = self.kv.read_text()
        out = self.run_tool("approve", "aaaa1111", "--dry-run").stdout
        self.assertIn("[dry run] updated Last Train", out)
        self.assertEqual(json.loads(self.prices.read_text()), self.original)
        self.assertEqual(self.kv.read_text(), before_kv)

    def test_unknown_id_stops_before_any_change(self):
        proc = self.run_tool("approve", "aaaa1111", "nope", ok=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("nope: no pending submission", proc.stderr)
        self.assertEqual(json.loads(self.prices.read_text()), self.original)
        self.assertEqual(len(json.loads(self.kv.read_text())), 3)

    def test_output_format_matches_the_committed_file(self):
        self.run_tool("approve", "bbbb2222")
        text = self.prices.read_text(encoding="utf-8")
        self.assertEqual(text, json.dumps(json.loads(text), indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
