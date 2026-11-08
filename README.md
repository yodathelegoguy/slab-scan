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
| Inventory status (scanned, in stock, listed, sold) with cost, sale price, fees, profit | Works | Tap a coin in the Collection tab to edit it; filter by status at the top. |
| CAC sticker, plus (+) and star (★) | Works | Plus and star fill in from the PCGS grade when present; CAC is entered by hand (not in the PCGS API). |
| Batch scan a box | Works | Camera stays open; one beep per new slab, a low double beep for duplicates. Saves without PCGS lookups, so fill details in later. |
| Shared collection across phones | Works with a free Cloudflare D1 database | Every phone using the same Worker and passcode syncs one collection, with offline scans uploaded later. See SETUP.md Part 4. |
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
npx wrangler deploy   # also creates/attaches the D1 database for the shared collection
```

### 3. Host the app
Serve the `docs/` folder over HTTPS (camera access requires it). With GitHub Pages: Settings → Pages → Deploy from a branch → `main`, folder `/docs`. The app is then at https://yodathelegoguy.github.io/slab-scan/

### 4. On the iPhone
1. Open the app URL in Safari → Share → **Add to Home Screen**.
2. Open Slab Scan → Settings → paste the worker URL and your APP_KEY → Test connection.
3. Scan away.

See [SECURITY.md](SECURITY.md) for passcode lockouts, rate limits, and putting the app behind a Cloudflare Access email sign-in.

## Data and privacy
The stored record format is documented in [DATA-MODEL.md](DATA-MODEL.md).

Your collection is stored on the phone (browser storage). With sharing on, it's also stored in the Worker's D1 database (binding `DB`), and every phone with the passcode syncs it through `POST /sync`. Without sharing, export regularly; clearing Safari website data deletes it.

### How sync works (for developers)
- `docs/sync.js` syncs localStorage collections listed in its `COLLECTIONS` array: arrays of records with a unique `id` (coins) or plain maps (saved Greysheet links). Whole records are sent, so new fields need no sync changes. To sync a new kind of data, add it to `COLLECTIONS`, save through the app's `save()` (which calls `SlabSync.changed()`), and reload your in-memory copy on the `slabsync:changed` window event.
- The Worker stores each record as `(kind, id) → JSON` in table `sync_records`, giving every write the next sequence number. Phones push changes and pull everything after the last number they saw. Newest `updatedAt` wins; deletions are kept as tombstones.
- `wrangler.jsonc` declares the D1 binding without a `database_id`, so `wrangler deploy` reuses (or creates) the database named `slab-scan-db`.
