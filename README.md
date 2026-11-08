# Slab Scan

An iPhone-friendly web app (PWA) that scans the barcode or QR code on PCGS and NGC coin slabs, pulls the coin's details from PCGS, and builds a collection you can export to Excel or CSV.

```
docs/     the phone app (static files, served by GitHub Pages)
worker/   a tiny lookup server (Cloudflare Worker) that keeps your API keys off the phone
```

## What works and what doesn't

| Feature | Status | Why |
|---|---|---|
| Scan PCGS barcode / QR | Works | Camera scanning runs in Safari; no app store needed. |
| PCGS coin details, price guide, population, photos, last auction | Works with a free PCGS API token | PCGS Public API, 1,000 calls/day. |
| Scan NGC barcode → coin details | Works through PCGS | The PCGS API decodes NGC holder barcodes (`gradingService=NGC`). |
| Type an NGC cert number → coin details | **Not possible** | NGC has no public API. The app saves the cert and gives you a one-tap NGC verification link instead. |
| ANACS / ICG / CACG | Scan + save only | No public APIs. |
| Greysheet (CDN) wholesale bid, automatic | **Needs a paid CDN dealer plan + API add-on** | CDN's API needs a Coin Dealer subscription, and wholesale (Greysheet) values need the Advanced tier (Dealer+ or Pro), billed per call with a $25/month minimum. The license allows this for your private use but not on a public website. |
| Greysheet bid, manual | Works | Type the bid on the result screen or tap `$` on any coin in the list. |
| Melt value from live spot | Works, no key needed | Gold, silver, platinum and palladium spot from the free gold-api.com feed (via the Worker's `/spot`, cached 5 minutes). Metal content comes from PCGS metal + weight, a built-in table of common US coins, or what you enter under "Metal content for melt value". |
| Spreadsheet export | Works | Excel (.xlsx) and CSV, via the iOS share sheet. |

## Setup (about 15 minutes)

**Start with [SETUP.md](SETUP.md)**: a click-by-click guide with no command line. The steps below are the command-line version for developers.

### 1. PCGS API token
1. Sign in at pcgs.com and open https://www.pcgs.com/publicapi
2. Generate your API access token and copy it.

### 2. Lookup server (Cloudflare Worker, free tier)
```bash
# from the repo root (wrangler.jsonc deploys the app + API as one Worker)
npx wrangler login
npx wrangler secret put APP_KEY      # make up a passcode
npx wrangler secret put PCGS_TOKEN   # paste the PCGS token
# optional, only with a CDN API plan:
npx wrangler secret put GREYSHEET_TOKEN
npx wrangler secret put GREYSHEET_KEY
npx wrangler deploy
```

### 3. Host the app
Serve the `docs/` folder over HTTPS (camera access requires it). With GitHub Pages: Settings → Pages → Deploy from a branch → `main`, folder `/docs`. The app is then at https://yodathelegoguy.github.io/slab-scan/

### 4. On the iPhone
1. Open the app URL in Safari → Share → **Add to Home Screen**.
2. Open Slab Scan → Settings → paste the worker URL and your APP_KEY → Test connection.
3. Scan away.

## Data and privacy
Your collection is stored on the phone (browser storage). Export regularly; clearing Safari website data deletes it.
