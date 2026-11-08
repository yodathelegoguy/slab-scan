# Slab Scan data model

Everything lives in the phone's `localStorage`, as JSON. Helpers that read or change a coin's
inventory and grade fields are in [`docs/inventory.js`](docs/inventory.js) (`window.SlabInventory`);
use them instead of re-implementing the rules.

## Storage keys

| Key | Contents |
|---|---|
| `slabscan.coins.v1` | Array of coin records (below), newest first. This is the collection / inventory. |
| `slabscan.config.v1` | Settings: `proxy`, `appKey`, `service`, `autoLookup`, `dailyLimit`. |
| `slabscan.greysheet.v1` | Saved Greysheet page per coin type: `{ "pcgs:<PCGS #>" or "name:<name>": url }`. |
| `slabscan.lookups.v1` | Cache of PCGS lookups (coin details only, no user fields). Safe to drop. |
| `slabscan.usage.v1` | PCGS calls used today: `{ day, calls }`. Per device. |
| `slabscan.listfilter.v1` | Last status filter on the Collection tab. Per device. |
| `slabscan.deallist.v1` | Array of deals (seller, date, status, lot offer, notes). Synced. Older versions kept these in `slabscan.deals.v1`, which `deals.js` migrates on load. |
| `slabscan.dealactive.v1` | Id of the deal this phone is scanning into. Per device. |
| `slabscan.offers.v1` | Offer settings: default % of Greysheet, category rules, rounding, offer-sheet text. Synced, so every phone offers the same way. |
| `slabscan.sync.v1`, `slabscan.syncshadow.v1` | Sync settings (your name, on/off, cursor) and what each record looked like at the last sync. Per device. |

Synced keys are listed in `COLLECTIONS` in [`docs/sync.js`](docs/sync.js): coins, Greysheet links, deals, offer settings.

## Coin record

Two kinds of fields: **coin details** come from the PCGS lookup and can be refreshed at any time;
**user fields** are typed by the user and must never be overwritten by a lookup
(`SlabInventory.USER_FIELDS` lists them).

### User fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Random, unique per record. Use it as the sync key. |
| `addedAt` | ISO datetime | When the coin was added. |
| `updatedAt` | ISO datetime | Last edit of any user field. Missing on records older than this field; treat as `addedAt`. Good for last-write-wins sync. |
| `status` | `""` \| `"bought"` \| `"listed"` \| `"sold"` | `""` = scanned only (appraised, not bought). Old records with a `paid` value are read as `"bought"`. |
| `paid` | number \| null | Cost: what was paid for the coin. |
| `listPrice` | number \| null | Asking price while listed. |
| `salePrice` | number \| null | What it sold for. |
| `fees` | number \| null | Selling costs (eBay fees, shipping). Subtracted from profit. |
| `boughtAt`, `listedAt`, `soldAt` | `YYYY-MM-DD` or `""` | Stamped with today's date when the coin first reaches that status; editable. |
| `soldTo` | string | Buyer or venue. |
| `cac` | `""` \| `"Green"` \| `"Gold"` | CAC sticker. Not in the PCGS API, so always entered by hand. |
| `plus` | boolean | Plus (+) grade. Filled from PCGS when the grade has a `+`. |
| `star` | boolean | Star (★) designation. Filled from the grade (`★` or `*`) when present. |
| `greysheet` | number \| null | Greysheet bid, entered by hand. |
| `greysheetUrl` | string | Saved Greysheet page for this coin. |
| `notes` | string | Free text. |
| `rawCode` | string | Exactly what was scanned or typed. |
| `meltMetal`, `meltOz` | string, number \| null | Metal content typed by the user for melt value (`meltMetal: "none"` turns melt off for the coin). Empty means use PCGS data or the built-in table in `melt.js`. |
| `dealId` | string | The deal (`slabscan.deallist.v1`) this coin was bought or offered in. |
| `offerPct`, `offerFixed` | number \| null | Per-coin offer override: a % of Greysheet, or a fixed price. |
| `addedBy` | string | Name of the phone's user (Settings → Your name) who added the coin. |

**Profit** is not stored. It is `salePrice - fees - paid` for sold coins with a sale price
(`SlabInventory.profit(coin)`), and `null` otherwise.

**Grade** is stored without `+`/`★` (`MS65`), with the marks in `plus`/`star`.
`SlabInventory.gradeLabel(coin)` gives the full label, e.g. `MS65+★ CAC Gold`.
Older records may still have the marks inside `grade`; `baseGrade()` and `gradeFlags()` handle both.

### Coin details (from the lookup server, `normalize()` in `worker/worker.js`)

`service` (`PCGS`, `NGC`, …), `certNo`, `pcgsNo`, `name`, `year`, `denomination`, `mintMark`,
`grade`, `designation` (e.g. `PL`, `DCAM`, `RD`), `plus`, `star`, `variety`, `series`, `category`, `country`,
`mintage`, `metal`, `weight`, `diameter`, `designer`, `priceGuide` (number), `population`, `popHigher`,
`coinFactsLink`, `image`, `thumb`, `lastAuction` (`{ date, price, auctioneer, url }`).

## Rules for code that changes records

- Run `SlabInventory.normalize(coin)` on records you load from storage or another device; it fills defaults and is safe to repeat.
- Change status with `SlabInventory.setStatus(coin, status)` so the stage date is stamped.
- Set `updatedAt = new Date().toISOString()` whenever a user field changes.
- When refreshing coin details from PCGS, keep every field in `USER_FIELDS`.
