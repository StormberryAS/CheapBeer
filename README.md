# CheapBeer

Crowdsourced tracker for draft pilsner prices across bars in Norway. Built by [Stormberry AS](https://stormberry.as).

**Live:** [beer.stormberry.as](https://beer.stormberry.as)

## Features
- **Crowdsourced database**: anyone can submit a price. Every submission is reviewed before it appears.
- **Advanced sorting**: filter by city, or sort by absolute price (NOK), size (L), or true value (price per litre).
- **Spam protection**: Cloudflare Turnstile, loaded only when someone starts filling in the submission form, plus rate limits on the Worker.
- **First-party data**: the published price list is a `prices.json` file committed in this repo and served from the app's own origin, with a full version-controlled history.

## Architecture
- **Vanilla HTML/CSS/JS** frontend, Stormberry dark-mode glassmorphism design system, Inter typography.
- **Privacy first**: no analytics and no cookies. Reading the price list contacts nothing but this site; the Turnstile spam check runs only once you start the submission form. A submission is held privately until it has been reviewed, and the form refuses free text that looks like an email address, a link or a phone number.
- **Backend**: a Cloudflare Worker checks the fields, applies rate limits, verifies Turnstile and stores the submission privately in Workers KV. It has no access to this repository and publishes nothing. No Google.
- **Security**: Cloudflare Turnstile.
- **Sovereign AI**, built and maintained using high-speed agentic workflows.

## Reviewing submissions

Nothing a visitor submits is published until it has been reviewed. The Worker stores each submission in a private Workers KV namespace (binding `SUBMISSIONS`). A submission nobody reviews deletes itself after 90 days. No IP address is stored with it.

To review, from the repository root, with wrangler logged in to the Stormberry Cloudflare account:

```
python3 tools/review_submissions.py                    # list what is waiting
python3 tools/review_submissions.py approve 1a2b3c4d   # copy into prices.json, remove from the store
python3 tools/review_submissions.py reject 5e6f7a8b    # remove from the store, publish nothing
```

The ID is the last eight characters of each key, as the listing shows it. Add `--dry-run` to see what would change. Approving a bar that is already listed (same name and city) updates its glass size, price and date; anything else becomes a new row with an empty `maps_url`. Then check `git diff prices.json`, fill in any `maps_url`, and commit and push `prices.json` as usual. That commit is the publication step.

### One-time setup for the private store

1. Create the namespace (done 2026-10-03): `cd worker && wrangler kv namespace create cheapbeer-submissions`, then paste the `id` it prints into `worker/wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`. Until then `wrangler deploy` fails, so this version cannot go live without its store.
2. Run the tests, `node worker/test.mjs` and `python3 tools/test_review_submissions.py`, then deploy from `worker/`: `wrangler deploy`.
3. Remove the old access. Done on 2026-10-03: the Worker that was live until then wrote to a Google Sheet through a service account, not to this repository, so its `GOOGLE_SERVICE_ACCOUNT_KEY` and `SHEET_ID` secrets were deleted. The service-account key itself should also be revoked in Google Cloud.

## Tests

- Worker: `node worker/test.mjs` (Node 20 or later, no dependencies).
- Review script: `python3 tools/test_review_submissions.py` (uses a fake wrangler, touches nothing live).

## Responsibility
CheapBeer is an independent data project for educational and informational purposes. Stormberry AS does not encourage, promote, or incentivise the consumption of alcohol. Always drink responsibly and in accordance with local laws.

## Credits
Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.

## Disclaimer

Supplied free of charge, **as is**, with no warranty of any kind. Using it creates no client or advisory relationship with Stormberry AS, and nothing it produces is professional advice.

**Alcohol is harmful.** The WHO states that no level of alcohol consumption is safe for health, and it is linked to liver disease, several cancers, mental illness and dependency. Do not drink to excess. Never drink and drive or operate machinery; Norway's limit is 0.2 per mille and the safe amount before driving is none. Help: **Rustelefonen 08588**.

**This application does not promote or incentivise drinking, and endorses no establishment listed.** It is a price list. No venue pays to appear and none is affiliated with Stormberry AS. Prices are submitted by the public, are unverified, may have been completed with AI assistance, and go stale. Ask at the bar.

This is a **functioning prototype**, not a certified instrument and not a professional service. Values are computed or modelled, not measured. Check anything that matters against an authoritative source before you act on it. Stormberry AS reimburses no cost or loss arising from use of this application.

Full terms: [DISCLAIMER.md](DISCLAIMER.md).
