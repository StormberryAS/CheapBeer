# CheapBeer

Crowdsourced tracker for draft pilsner prices across bars in Norway. Built by [Stormberry AS](https://stormberry.as).

**Live:** [beer.stormberry.as](https://beer.stormberry.as)

## Features
- **Crowdsourced database**: anyone can submit a price update. Prices are validated and auto-approved after three matching submissions.
- **Advanced sorting**: filter by city, or sort by absolute price (NOK), size (L), or true value (price per litre).
- **Spam protection**: integrated Cloudflare Turnstile, no intrusive captchas.
- **First-party data**: the price list is a `prices.json` file committed in this repo and served from the app's own origin, with a full version-controlled history. No third-party datastore.

## Architecture
- **Vanilla HTML/CSS/JS** frontend, Stormberry dark-mode glassmorphism design system, Inter typography.
- **Privacy first**, no analytics, no cookies, no fingerprinting, no location or personal data collected.
- **Backend**: a Cloudflare Worker verifies Turnstile and commits approved submissions to `prices.json` via the GitHub Contents API. No Google.
- **Security**: Cloudflare Turnstile.
- **Sovereign AI**, built and maintained using high-speed agentic workflows.

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
