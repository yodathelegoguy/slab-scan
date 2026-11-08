# Keeping the lookup server private

The PCGS token never leaves Cloudflare, so nobody can steal it from the app. The risks of a
public link are someone burning your 100 PCGS lookups a day, or (once sync is on) reading your
inventory. There are three layers. The first is already on; the other two are a few minutes of
clicking in Cloudflare.

## 1. Built in (nothing to do)

Once this code is deployed, the Worker:

- **Locks out guessers.** 5 wrong passcodes from one internet address within 15 minutes locks
  that address out for an hour, even if it then sends the right passcode.
- **Rate limits everyone.** Each address gets at most 60 API calls a minute.
- **Checks the passcode in constant time**, so response timing gives away nothing about it.
- **Caches PCGS answers in the database for 30 days**, shared by every phone. (The old cache
  never worked on a `workers.dev` address, so this saves real lookups.)

If you lock yourself out, wait an hour, or clear it: **Workers & Pages → D1 SQL database →
slab-scan-db → Console**, run `DELETE FROM sec_auth_fail;`.

## 2. Use a long passcode (2 minutes)

A short word can be guessed; four or five random words can't.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **slab-scan**.
2. **Settings** → **Variables and Secrets** → next to `APP_KEY`, click **Edit** (the pencil).
3. Paste something like `brass-velvet-otter-1881-quarry` → **Deploy**.
4. On each phone: open Slab Scan → **Settings** → paste the new passcode → **Test connection**.

## 3. Cloudflare Access: sign in with your email (10 minutes, free)

This is the big one. Nobody reaches the app or the server without first typing a one-time code
that Cloudflare emails to an address you approved. A leaked link or passcode alone gets nothing.
It's free for up to 50 people.

### a. Turn on email codes

1. In the Cloudflare dashboard, click **Zero Trust** in the left sidebar.
   - First time only: it asks you to pick a **team name** (e.g. `slabscan`; write it down) and a
     plan. Choose **Free**. It may ask for a card; the Free plan is $0.
2. Go to **Integrations** → **Identity providers** → **Add new identity provider** →
   **One-time PIN**. That's it; there's nothing to fill in.

### b. Put the Worker behind Access

1. Back in the main dashboard: **Workers & Pages** → **slab-scan** → the **Access** tab.
2. Click **Protect this Worker behind Access** → choose **All traffic**.
3. Under **Authentication policy**, pick **Cloudflare account** for now → **Apply Access**.
4. Now add the people allowed in. Go to **Zero Trust** → **Access controls** → **Applications** →
   find **slab-scan** → **Edit**.
   - **Policies**: edit the policy → under **Include**, set the selector to **Emails** and add each
     person's email (yours and any staff) → **Save**.
   - **Login methods** (or **Authentication**): make sure **One-time PIN** is ticked.
   - **Session Duration**: pick **1 month** so phones only sign in about once a month.
   - **Save application**.

### c. Try it

1. Open `https://slab-scan.carsonrwells.workers.dev` in a private browser window. You should see a
   Cloudflare sign-in page instead of the app.
2. Type your email → **Send login code** → paste the code from your email. The app opens.
3. On the iPhone, open Slab Scan from the home screen; it shows the same sign-in page once.
   Codes come from `noreply@notify.cloudflare.com` (check spam the first time).

When a sign-in runs out, lookups say "Your sign-in has expired". Close and reopen the app to
sign in again. Scans still save while signed out.

Note: with Access on, use the app from the `workers.dev` address. The GitHub Pages copy can't
sign in to the server.

## 4. Optional: double-check every call in the code

Step 3 already blocks outsiders. This step makes the Worker itself also refuse any API call
without a valid Access sign-in, as a backstop if Access were ever switched off by mistake or a
preview link slipped past it.

1. Find your **AUD tag**: **Zero Trust** → **Access controls** → **Applications** → **slab-scan** →
   **Edit** → look for **Application Audience (AUD) Tag** (under **Overview** or **Additional
   settings**) → copy it.
2. Your **team name** is the one from step 3a. It's also in the address of the sign-in page:
   `https://YOURTEAM.cloudflareaccess.com/...`.
3. **Workers & Pages** → **slab-scan** → **Settings** → **Variables and Secrets** → **Add**:
   - Type **Text**, name `ACCESS_TEAM_DOMAIN`, value your team name (e.g. `slabscan`).
   - Type **Text**, name `ACCESS_AUD`, value the AUD tag.
   - **Deploy**.
4. Open `https://slab-scan.carsonrwells.workers.dev/status`. It should say `"accessCheck":true`.
   Then do a test scan.

If every lookup now says "Sign-in required" even right after signing in, one of the two values
is wrong. Delete both variables to switch this check off, then try again.
