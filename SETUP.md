# Slab Scan setup, step by step

No command line needed. Everything is done in a web browser (a computer is easiest, but an iPad works too). Total time is about 15 minutes.

You'll do three things:
1. Get a PCGS API token (lets the app look up coins).
2. Make a free Cloudflare "Worker" (a tiny private server that keeps that token secret).
3. Add the app to your iPhone and connect it to the Worker.

---

## Part 1: Get your PCGS API token (3 min)

1. Go to **https://www.pcgs.com/publicapi** and sign in with your PCGS account (create a free one if you don't have it).
2. Follow the prompts on that page to request API access and generate your token.
3. You'll get a long string of letters and numbers. **Copy it** and keep it somewhere handy (Notes app is fine for now). Don't share it or paste it in any chat.

The free tier allows 1,000 lookups a day.

---

## Part 2: Create the lookup server on Cloudflare (8 min)

### 2a. Create the Worker
1. Go to **https://dash.cloudflare.com/sign-up** and create a free account (or sign in).
2. In the left menu, click **Compute (Workers)** → **Workers & Pages**.
   *(On some accounts it's just called "Workers & Pages".)*
3. Click **Create** → **Create Worker** (pick the "Hello World" starter if asked).
4. Name it **`slab-scan`** and click **Deploy**.
5. Cloudflare shows your Worker's address, like `https://slab-scan.YOURNAME.workers.dev`. **Copy this URL**; the app needs it later.

### 2b. Paste in the Slab Scan code
1. Click **Edit code** (top right).
2. Open **https://raw.githubusercontent.com/yodathelegoguy/slab-scan/main/worker/worker.js** in another tab, select all the text, and copy it.
3. Back in the Cloudflare editor, click into `worker.js`, select everything that's there, delete it, and paste the code you copied.
4. Click **Deploy** (top right), then click the back arrow to return to the Worker's page.

### 2c. Add your settings and secrets
1. On the Worker's page, click **Settings** → **Variables and Secrets** → **Add**.
2. Add these two secrets one at a time, then click **Deploy**:

| Type | Variable name | Value |
|---|---|---|
| Secret | `PCGS_TOKEN` | the PCGS token from Part 1 |
| Secret | `APP_KEY` | a long passcode you make up, e.g. `brass-velvet-otter-1881-quarry` |

Type the names exactly as shown (capital letters and underscores matter).

**Remember the APP_KEY passcode**; you'll type it into the app once.

To lock the link down further (email sign-in with Cloudflare Access), see [SECURITY.md](SECURITY.md).

**Check it:** open your Worker URL in a browser. You should see `"app":"Slab Scan lookup server"` with `appKeySet` and `pcgsTokenSet` both `true`. If you see "Hello World!" instead, the code wasn't pasted or deployed (repeat 2b).

*(Only if you later buy CDN's API add-on: also add secrets `GREYSHEET_TOKEN` and `GREYSHEET_KEY`.)*

---

## Part 3: Set up the app on your iPhone (3 min)

1. On your iPhone, open **Safari** and go to **https://yodathelegoguy.github.io/slab-scan/**
2. Tap the **Share** button (square with an arrow) → **Add to Home Screen** → **Add**.
3. Open **Slab Scan** from your Home Screen.
4. Tap **Settings** in the app:
   - **Lookup server URL**: paste the Worker URL from step 2a (e.g. `https://slab-scan.YOURNAME.workers.dev`).
   - **App passcode**: the `APP_KEY` you made up.
   - Tap **Save**, then **Test connection**. You should see *"Connected. PCGS key: set."*
5. Tap **Scan** → **Start camera** → **Allow** camera access → point at a slab's barcode.

---

## Part 4: Share one collection across phones (optional, 5 min)

Every phone that uses the same Worker URL and passcode can share one collection, so coins scanned by anyone show up on everyone's phone (within about 30 seconds). The collection is stored in a free Cloudflare **D1** database attached to your Worker.

### 4a. Check whether the database is already there
Open **https://slab-scan.carsonrwells.workers.dev/status** in a browser.

- `"syncDatabaseSet":true` means Cloudflare already created and attached the database when it deployed the latest code. Skip to 4c.
- `"syncDatabaseSet":false` means you need to attach it by hand. Do 4b.

### 4b. Create the database and attach it (only if 4a said false)
1. In the Cloudflare dashboard, open the left menu and click **Storage & Databases** → **D1 SQL Database**.
2. Click **Create Database** (or **Create**).
3. Name it exactly **`slab-scan-db`**. Leave the location on automatic. Click **Create**.
4. In the left menu, go to **Compute (Workers)** → **Workers & Pages** → click **slab-scan**.
5. Click **Settings** → **Bindings** → **Add** (on some accounts it's **Add binding**).
6. Choose **D1 database**.
7. **Variable name**: type **`DB`** (capital letters). **D1 database**: pick **slab-scan-db**.
8. Click **Add Binding** (or **Save** / **Deploy**).
9. Open the `/status` link from 4a again. It should now say `"syncDatabaseSet":true`.

You don't need to create any tables; the app sets them up the first time a phone syncs. Use the name `slab-scan-db` so future deploys from GitHub keep using the same database.

### 4c. Turn it on in the app (each phone)
1. Make sure the phone has the **Lookup server URL** and **App passcode** filled in (Part 3).
2. In the app, tap **Settings** → **Shared collection**.
3. Type **Your name** (shown next to coins you add and in the export's "Added By" column).
4. Make sure **Share this phone's collection** is checked, and tap **Sync now**.
5. The status line should say *"Shared collection: N coins. Last synced …"*. A small green dot on the Settings tab means sharing is working; amber means the last sync failed (the status line says why).

The first sync adds whatever is already on that phone to the shared collection, so nothing is lost. Scans made with no signal are saved on the phone and go up automatically when it's back online.

**Good to know**
- Anyone with the passcode can see and change the shared collection. Names are labels, not separate logins.
- **Clear all** and deleting a coin remove it from every phone. Export a copy first if you're unsure.
- If two people edit the same coin at nearly the same time, the later edit wins.
- Uncheck **Share this phone's collection** to keep a phone separate.
- Cloudflare's free D1 tier is far more than a buying office needs.

---

## Using it

- **Auto / PCGS / NGC** at the top tells the app which company's slab you're scanning. Auto works for most; switch to NGC if an NGC barcode doesn't find anything.
- After a scan, type the **Greysheet bid**, **price paid**, CAC, and notes, then **Add to collection**. The camera restarts for the next coin.
- **Collection** tab: see totals, tap **$** on a coin to change its Greysheet bid, **✕** to delete.
- **Export Excel** opens the iPhone share sheet, so you can save to Files, AirDrop, or email it.

Your collection is saved on the phone, and also on your Worker's database if you turned on sharing (Part 4). Without sharing, export now and then as a backup, because clearing Safari's website data erases it.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| "Could not reach…" | Open the Worker URL in Safari. "Hello World!" means the Slab Scan code isn't deployed yet (repeat 2b). An error page means the URL is wrong. |
| "Wrong or missing app passcode" | The app passcode must exactly match `APP_KEY` in Cloudflare. |
| "PCGS_TOKEN is not set" | Add the `PCGS_TOKEN` secret in Cloudflare and click Deploy. |
| "PCGS rejected the request" | The PCGS token is wrong or expired. Generate a new one and replace the secret. |
| Settings says "The server isn't set up for sharing yet" | The Worker has no D1 database attached. Do Part 4b. |
| Camera won't start | iPhone Settings → Safari → Camera → Allow. |
| Barcode won't read | Tilt the slab to remove glare, move 4–6 inches away, or type the cert number. |
