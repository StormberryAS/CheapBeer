# CheapBeer

Crowdsourced tracker for the cheapest draft pilsner across bars in Norway. Built by [Stormberry AS](https://stormberry.as).

**Live:** [beer.stormberry.as](https://beer.stormberry.as)

## Features
- **Crowdsourced database**: anyone can submit a price update. Prices are validated and auto-approved after three matching submissions.
- **Advanced sorting**: filter by city, or sort by absolute price (NOK), size (L), or true value (price per litre).
- **Spam protection**: integrated Cloudflare Turnstile, no intrusive captchas.
- **Real-time data**: lightweight backend on Cloudflare Workers proxying a Google Sheets datastore.

## Architecture
- **Vanilla HTML/CSS/JS** frontend, Stormberry dark-mode glassmorphism design system, Inter typography.
- **Privacy first**, no analytics, no cookies, no fingerprinting, no location or personal data collected.
- **Backend**: Cloudflare Workers proxying to a Google Sheets API.
- **Security**: Cloudflare Turnstile.
- **Sovereign AI**, built and maintained using high-speed agentic workflows.

## Responsibility
CheapBeer is an independent data project for educational and informational purposes. Stormberry AS does not encourage, promote, or incentivise the consumption of alcohol. Always drink responsibly and in accordance with local laws.

## Credits
Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.
