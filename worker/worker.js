// Slab Scan lookup server (Cloudflare Worker).
// Holds the PCGS / Greysheet credentials so they never ship to the phone.
//
// Secrets (set with `wrangler secret put NAME` or in the dashboard):
//   APP_KEY            passcode the app sends in X-App-Key
//   PCGS_TOKEN         bearer token from your PCGS account's Public API page
//   GREYSHEET_TOKEN    optional, CDN API x-api-token
//   GREYSHEET_KEY      optional, CDN API x-api-key
//
// Optional security settings (variables, see SECURITY.md):
//   ACCESS_TEAM_DOMAIN  your Cloudflare Zero Trust team name, e.g. "slabscan"
//   ACCESS_AUD          the Access application's Audience (AUD) tag
//     When both are set, every API call must carry a valid Cloudflare Access
//     login, so a leaked passcode alone is useless.
// Bindings (wrangler.jsonc): API_LIMIT and AUTH_FAIL_LIMIT rate limiters;
// DB (D1, optional) for lockouts and a PCGS lookup cache that survives.
// Binding (optional, turns on the shared collection):
//   DB                 a Cloudflare D1 database. The table is created on first use.

const PCGS = "https://api.pcgs.com/publicapi";
const CDN = "https://cpgpublicapiv2.greysheet.com/api";
// Free spot prices, no key needed. Cached for 5 minutes so the source is hit rarely.
const SPOT = "https://api.gold-api.com/price/";
const SPOT_SYMBOLS = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" };

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const isApi = url.pathname === "/health" || url.pathname === "/lookup" || url.pathname === "/status"
      || url.pathname === "/spot" || url.pathname === "/sync" || url.pathname.startsWith("/greysheet/");
    // When deployed from the repo, the same Worker also serves the phone app (docs/).
    if (!isApi && env.ASSETS) return env.ASSETS.fetch(req);
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/status") {
      // Open the Worker URL in a browser to confirm it's running and configured.
      return json({
        ok: true, app: "Slab Scan lookup server",
        appKeySet: Boolean(env.APP_KEY), pcgsTokenSet: Boolean(env.PCGS_TOKEN),
        accessCheck: Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN),
        rateLimit: Boolean(env.API_LIMIT), databaseSet: Boolean(env.DB), syncDatabaseSet: Boolean(env.DB),
      }, 200, cors);
    }
    // Spot prices are public market data, so they don't need the app passcode.
    if (url.pathname === "/spot") {
      try { return json(await spotPrices(), 200, { ...cors, "Cache-Control": "max-age=60" }); }
      catch (e) { return json({ ok: false, error: "Spot prices unavailable: " + (e && e.message || e) }, 502, cors); }
    }
    const denied = await requireAuth(req, env);
    if (denied) return json(denied.body, denied.status, { ...cors, ...(denied.headers || {}) });

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          pcgs: Boolean(env.PCGS_TOKEN),
          greysheet: Boolean(env.GREYSHEET_TOKEN && env.GREYSHEET_KEY),
          sync: Boolean(env.DB),
        }, 200, cors);
      }
      if (url.pathname === "/sync") {
        if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
        if (!env.DB) return json({ ok: false, noDatabase: true, error: "Sync isn't set up on the server yet. Add a D1 database binding named DB (see SETUP.md)." }, 501, cors);
        let body;
        try { body = await req.json(); } catch { return json({ ok: false, error: "Bad sync request." }, 400, cors); }
        return json(await sync(env.DB, body || {}), 200, cors);
      }
      if (url.pathname === "/lookup") return json(await lookup(url.searchParams, env), 200, cors);

      // Raw pass-through to the CDN API (GET only) so Greysheet endpoints can be
      // wired in once their catalog is visible with a dealer login:
      //   /greysheet/GetNodeRequest?NodeId=1
      if (url.pathname.startsWith("/greysheet/")) {
        if (!env.GREYSHEET_TOKEN || !env.GREYSHEET_KEY) {
          return json({ ok: false, error: "Greysheet API keys are not set on the server." }, 501, cors);
        }
        const target = CDN + url.pathname.slice("/greysheet".length) + url.search;
        const r = await fetch(target, {
          headers: { "x-api-token": env.GREYSHEET_TOKEN, "x-api-key": env.GREYSHEET_KEY },
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": r.headers.get("Content-Type") || "application/json" },
        });
      }
      return json({ ok: false, error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502, cors);
    }
  },
};

async function lookup(params, env) {
  const service = (params.get("service") || "PCGS").toUpperCase();
  const cert = (params.get("cert") || "").trim();
  const barcode = (params.get("barcode") || "").trim();
  if (!env.PCGS_TOKEN) return { ok: false, error: "PCGS_TOKEN is not set on the server." };
  const token = String(env.PCGS_TOKEN).trim().replace(/^bearer\s+/i, "");
  const gs = service === "NGC" ? "NGC" : "PCGS";

  // Build every reasonable way PCGS might recognise this slab, most specific first.
  const plan = [];
  const add = (label, path) => { if (!plan.some(p => p.path === path)) plan.push({ label, path }); };
  const byCert = c => add(`cert ${c}`, `/coindetail/GetCoinFactsByCertNo/${encodeURIComponent(c)}`);
  const byBarcode = (b, svc) => add(`barcode ${b} (${svc})`, `/coindetail/GetCoinFactsByBarcode?barcode=${encodeURIComponent(b)}&gradingService=${svc}`);
  const raw = barcode || cert;
  if (gs === "PCGS" && cert) byCert(cert);
  if (raw) byBarcode(raw, gs);
  if (gs === "PCGS") {
    // Digit runs inside the scanned text that could be the cert number.
    const runs = (raw.match(/\d{6,}/g) || []).sort((x, y) => y.length - x.length);
    for (const run of runs) {
      if (run.length <= 10) byCert(run.replace(/^0+(?=\d{6})/, ""));
      if (run.length > 8) { byCert(run.slice(-8)); byCert(run.slice(-7)); byCert(run.slice(0, 8)); }
    }
  } else if (cert) {
    byBarcode(cert.replace(/-/g, ""), "NGC");
  }
  if (!plan.length) return { ok: false, error: "Nothing to look up." };

  // PCGS limits calls, so a normal lookup makes exactly one: the first (most likely) route.
  // "deep" mode tries up to 3 of the remaining routes, only when the user asks.
  const deep = params.get("mode") === "deep";
  if (gs === "NGC" && !barcode && !deep) {
    return { ok: false, error: "NGC has no public lookup API, so a typed NGC cert can't be looked up. Scan the NGC barcode instead, or use the NGC verification link.", attempts: [], calls: 0, canTryHarder: true };
  }
  const steps = deep ? plan.slice(1, 4) : plan.slice(0, 1);
  if (!steps.length) return { ok: false, error: "No other ways left to try for this code.", attempts: [], calls: 0, canTryHarder: false };

  const attempts = [];
  let calls = 0;
  for (const step of steps) {
    let r, d = null, text = "";
    const cd = await cacheGet(env, step.path);
    if (cd) {
      attempts.push({ try: step.label, result: "from cache (no PCGS call)" });
      return { ok: true, source: "PCGS CoinFacts (cached)", coin: normalize(cd, service), attempts, calls };
    }
    try {
      calls++;
      r = await fetch(PCGS + step.path, { headers: { Authorization: `bearer ${token}`, Accept: "application/json" } });
      text = await r.text();
      try { d = JSON.parse(text); } catch {}
    } catch (e) {
      attempts.push({ try: step.label, result: "network error: " + e.message });
      continue;
    }
    const msg = d && (d.ServerMessage || d.Message || d.message) || text.slice(0, 120);
    attempts.push({ try: step.label, status: r.status, result: msg || "(empty)" });
    if (r.status === 401 || r.status === 403 || (r.status === 500 && /auth|token|credential/i.test(text))) {
      return { ok: false, error: "PCGS rejected your API token. Generate a new one at pcgs.com/publicapi and update PCGS_TOKEN in Cloudflare.", attempts, calls, canTryHarder: false };
    }
    if (r.status === 429 || /limit|quota|exceed/i.test(msg)) {
      return { ok: false, error: "You've hit your PCGS lookup limit. Scans still save; look them up after the limit resets.", attempts, calls, canTryHarder: false, limited: true };
    }
    if (r.ok && d && d.IsValidRequest !== false && (d.Name || d.PCGSNo)) {
      await cachePut(env, step.path, d);
      return { ok: true, source: "PCGS CoinFacts", coin: normalize(d, service), attempts, calls };
    }
  }
  const allTokenErrors = attempts.length && attempts.every(a => a.status === 500);
  return {
    ok: false,
    error: allTokenErrors
      ? "PCGS returned a server error for every try, which usually means the API token is invalid or expired."
      : "PCGS didn't recognise this slab using the scanned code.",
    attempts, calls,
    canTryHarder: !deep && plan.length > 1,
  };
}

// The Cache API does nothing on *.workers.dev, so also keep the last answer in memory
// for 5 minutes. That keeps the public /spot route from hammering gold-api.com.
let spotMemo = null;
async function spotPrices() {
  if (spotMemo && Date.now() - spotMemo.at < 300000) return { ...spotMemo.out, cached: true };
  const out = await spotPricesUncached();
  spotMemo = { at: Date.now(), out };
  return out;
}
async function spotPricesUncached() {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://slab-scan-cache.internal/spot");
  if (cache) { const hit = await cache.match(key); if (hit) return { ...(await hit.json()), cached: true }; }
  const prices = {}; let updatedAt = null;
  await Promise.all(Object.entries(SPOT_SYMBOLS).map(async ([metal, sym]) => {
    const r = await fetch(SPOT + sym, { headers: { Accept: "application/json" } });
    if (!r.ok) return;
    const d = await r.json().catch(() => null);
    if (d && typeof d.price === "number") {
      prices[metal] = d.price;
      if (d.updatedAt && (!updatedAt || d.updatedAt > updatedAt)) updatedAt = d.updatedAt;
    }
  }));
  if (!Object.keys(prices).length) throw new Error("the price source didn't answer");
  const out = { ok: true, prices, updatedAt: updatedAt || new Date().toISOString(), source: "gold-api.com", unit: "USD per troy oz" };
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" },
    })).catch(() => {});
  }
  return out;
}

function normalize(d, service) {
  const img = Array.isArray(d.Images) && d.Images[0] ? d.Images[0] : {};
  return {
    service,
    certNo: d.CertNo || "",
    pcgsNo: d.PCGSNo || "",
    name: d.Name || "",
    year: d.Year || "",
    denomination: d.Denomination || "",
    mintMark: d.MintMark || "",
    grade: d.Grade || "",
    designation: d.Designation || "",
    // Plus and star designations (see DATA-MODEL.md). PCGS puts "+" in the grade
    // and may also send a flag; NGC-style stars show as "★" or "*" in the grade.
    plus: d.IsPlusGrade === true || d.PlusGrade === true || /\+/.test(String(d.Grade || "")),
    star: d.IsStar === true || d.Star === true || /[★*]/.test(String(d.Grade || "")) || /\bstar\b/i.test(String(d.Designation || "")),
    variety: [d.MajorVariety, d.MinorVariety, d.DieVariety].filter(Boolean).join(" / "),
    series: d.SeriesName || "",
    category: d.Category || "",
    country: d.Country || "",
    mintage: d.Mintage || "",
    metal: d.MetalContent || "",
    weight: d.Weight || "",
    diameter: d.Diameter || "",
    designer: d.Designer || "",
    priceGuide: typeof d.PriceGuideValue === "number" ? d.PriceGuideValue : null,
    population: d.Population ?? null,
    popHigher: d.PopHigher ?? null,
    coinFactsLink: d.CoinFactsLink || "",
    image: img.Fullsize || img.Thumbnail || "",
    thumb: img.Thumbnail || img.Fullsize || "",
    lastAuction: Array.isArray(d.AuctionList) && d.AuctionList[0] ? {
      date: d.AuctionList[0].Date, price: d.AuctionList[0].Price,
      auctioneer: d.AuctionList[0].Auctioneer, url: d.AuctionList[0].AuctionLotUrl,
    } : null,
  };
}

// ---------- shared collection (D1) ----------
// Every synced thing is a generic record: (kind, id) -> JSON data. The app decides what
// the kinds are ("coin", "gslink", "deal", ...), so new fields and new kinds need no
// server change. Each write gets the next sequence number, and a device asks for
// everything after the last number it saw. The newest edit (by updatedAt) wins.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sync_records (
    kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL, updated_by TEXT, seq INTEGER NOT NULL,
    PRIMARY KEY (kind, id))`,
  `CREATE INDEX IF NOT EXISTS sync_records_seq ON sync_records (seq)`,
];
const PAGE = 500, MAX_PUSH = 500, MAX_DATA = 256 * 1024;

async function sync(db, body) {
  await schema({ DB: db });
  const by = String(body.by || "").trim().slice(0, 60) || null;
  const now = Date.now();
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_PUSH) : [];
  const rejected = [];
  const valid = [];
  for (const c of changes) {
    const kind = String(c && c.kind || "").slice(0, 40), id = String(c && c.id || "").slice(0, 200);
    if (!kind || !id) continue;
    const data = c.deleted ? null : JSON.stringify(c.data ?? null);
    if (data && data.length > MAX_DATA) { rejected.push({ kind, id, error: "too large" }); continue; }
    // A phone with a wrong clock can't push a date far in the future and lock a record.
    const at = Math.min(Number(c.updatedAt) || now, now + 60000);
    valid.push({ kind, id, data, deleted: c.deleted ? 1 : 0, at });
  }
  const upsert = db.prepare(`INSERT INTO sync_records (kind, id, data, deleted, updated_at, updated_by, seq)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_records))
    ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, seq = excluded.seq
    WHERE excluded.updated_at > sync_records.updated_at
    RETURNING seq`);
  const conflicts = [];
  if (valid.length) {
    const res = await db.batch(valid.map(v => upsert.bind(v.kind, v.id, v.data, v.deleted, v.at, by)));
    res.forEach((r, i) => { if (!r.results || !r.results.length) conflicts.push(valid[i]); });
  }

  const max = (await db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM sync_records").first()).m;
  let since = Math.max(0, Number(body.since) || 0);
  // The database was replaced, so this device's place in it is meaningless: start over.
  const reset = since > max;
  if (reset) since = 0;
  const { results } = await db.prepare(
    "SELECT kind, id, data, deleted, updated_at, updated_by, seq FROM sync_records WHERE seq > ?1 ORDER BY seq LIMIT ?2"
  ).bind(since, PAGE).all();
  const rows = results.map(rowOut);
  // A pushed edit that lost to a newer one: send the winner back even if it's older than `since`.
  const seen = new Set(rows.map(r => r.kind + "\n" + r.id));
  const lost = conflicts.filter(c => !seen.has(c.kind + "\n" + c.id));
  if (lost.length) {
    const winners = await db.batch(lost.map(c =>
      db.prepare("SELECT kind, id, data, deleted, updated_at, updated_by, seq FROM sync_records WHERE kind = ?1 AND id = ?2").bind(c.kind, c.id)));
    winners.forEach(w => (w.results || []).forEach(r => rows.push(rowOut(r))));
  }
  const cursor = results.length ? results[results.length - 1].seq : since;
  return { ok: true, cursor, more: results.length === PAGE, reset, accepted: valid.length - conflicts.length, rejected, changes: rows, serverTime: now };
}

function rowOut(r) {
  let data = null;
  if (!r.deleted && r.data != null) { try { data = JSON.parse(r.data); } catch {} }
  return { kind: r.kind, id: r.id, data, deleted: Boolean(r.deleted), updatedAt: r.updated_at, by: r.updated_by || "", seq: r.seq };
}

// The APP_KEY passcode is what protects the server, so any origin may call it.
// (ALLOWED_ORIGIN is no longer required; a typo there used to block the app.)
function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "X-App-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

// ---------- security ----------
// Every API call (lookups, Greysheet, sync) goes through requireAuth. Checks, in order:
//   1. per-IP request rate limit (API_LIMIT binding)
//   2. Cloudflare Access login, when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set
//   3. lockout after too many wrong passcodes from one IP
//   4. the APP_KEY passcode, compared in constant time
// Returns null when the request may go ahead, else { status, body, headers }.
const FAIL_WINDOW = 15 * 60;   // count wrong passcodes over 15 minutes
const FAIL_MAX = 5;            // this many wrong passcodes...
const LOCK_FOR = 60 * 60;      // ...locks that IP out for an hour
const CACHE_TTL = 30 * 86400;  // keep PCGS answers for 30 days

async function requireAuth(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const deny = (status, error, extra = {}, headers) => ({ status, body: { ok: false, error, ...extra }, headers });

  if (env.API_LIMIT) {
    const { success } = await env.API_LIMIT.limit({ key: ip });
    if (!success) return deny(429, "Too many requests. Wait a minute and try again.", {}, { "Retry-After": "60" });
  }

  if (env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    const who = await verifyAccess(req, env).catch(() => null);
    if (!who) return deny(403, "Sign-in required. Close and reopen the app to sign in again.", { signIn: true });
  }

  const locked = await lockedUntil(env, ip);
  if (locked) {
    const wait = Math.max(1, Math.ceil((locked - now()) / 60));
    return deny(429, `Too many wrong passcodes. This device is locked out for about ${wait} more minute${wait === 1 ? "" : "s"}.`,
      { locked: true }, { "Retry-After": String(locked - now()) });
  }

  if (!env.APP_KEY) return deny(401, "APP_KEY is not set on the server. Add it under Settings > Variables and Secrets.");
  const sent = (req.headers.get("X-App-Key") || "").trim();
  if (!(await safeEqual(sent, String(env.APP_KEY).trim()))) {
    const lockedNow = await recordFailure(env, ip);
    if (lockedNow) return deny(429, "Too many wrong passcodes. This device is locked out for an hour.", { locked: true }, { "Retry-After": String(LOCK_FOR) });
    return deny(401, "Wrong or missing app passcode.");
  }
  return null;
}

const now = () => Math.floor(Date.now() / 1000);

// Hashing first makes both sides the same length, so the compare leaks nothing about the passcode.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// All tables in the one D1 database (binding DB): sync_records (shared collection),
// sec_auth_fail (passcode lockouts) and pcgs_cache. They're created on first use, so
// there's nothing to set up by hand.
let schemaReady = null;
function schema(env) {
  if (!env.DB) return Promise.resolve(false);
  schemaReady ||= env.DB.batch([
    ...SCHEMA.map(q => env.DB.prepare(q)),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sec_auth_fail (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pcgs_cache (path TEXT PRIMARY KEY, body TEXT NOT NULL, saved_at INTEGER NOT NULL)"),
  ]).then(() => true).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

async function lockedUntil(env, ip) {
  if (!env.DB) return 0;
  try {
    await schema(env);
    const row = await env.DB.prepare("SELECT locked_until FROM sec_auth_fail WHERE ip = ?1").bind(ip).first();
    return row && row.locked_until > now() ? row.locked_until : 0;
  } catch { return 0; }
}

// Returns true when this failure tipped the IP into a lockout.
async function recordFailure(env, ip) {
  if (env.DB) {
    try {
      await schema(env);
      const t = now();
      const row = await env.DB.prepare(`
        INSERT INTO sec_auth_fail (ip, fails, window_start, locked_until) VALUES (?1, 1, ?2, 0)
        ON CONFLICT(ip) DO UPDATE SET
          fails = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END,
          window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
          locked_until = CASE WHEN (CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END) >= ?4 THEN ?2 + ?5 ELSE locked_until END
        RETURNING locked_until`).bind(ip, t, FAIL_WINDOW, FAIL_MAX, LOCK_FOR).first();
      return Boolean(row && row.locked_until > t);
    } catch { /* fall through to the rate limiter */ }
  }
  // Without a database, the AUTH_FAIL_LIMIT binding still caps guesses at a few per minute.
  if (env.AUTH_FAIL_LIMIT) {
    const { success } = await env.AUTH_FAIL_LIMIT.limit({ key: ip });
    return !success;
  }
  return false;
}

// ---------- PCGS lookup cache ----------
// The Workers Cache API does nothing on *.workers.dev or behind Cloudflare Access,
// so cached answers live in D1 when it's bound, with the Cache API as a fallback for custom domains.
async function cacheGet(env, path) {
  if (env.DB) {
    try {
      await schema(env);
      const row = await env.DB.prepare("SELECT body, saved_at FROM pcgs_cache WHERE path = ?1").bind(path).first();
      if (row && now() - row.saved_at < CACHE_TTL) return JSON.parse(row.body);
    } catch {}
    return null;
  }
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return null;
  const hit = await cache.match(new Request("https://slab-scan-cache.internal" + path)).catch(() => null);
  return hit ? hit.json().catch(() => null) : null;
}

async function cachePut(env, path, data) {
  if (env.DB) {
    try {
      await schema(env);
      await env.DB.prepare("INSERT OR REPLACE INTO pcgs_cache (path, body, saved_at) VALUES (?1, ?2, ?3)")
        .bind(path, JSON.stringify(data), now()).run();
    } catch {}
    return;
  }
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return;
  await cache.put(new Request("https://slab-scan-cache.internal" + path), new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL}` },
  })).catch(() => {});
}

// ---------- Cloudflare Access ----------
// Checks the signed login token Cloudflare Access attaches to each request, so the API
// stays closed even on a URL Access doesn't cover (like a preview link).
let accessKeys = { team: "", at: 0, keys: [] };

function teamUrl(env) {
  const t = String(env.ACCESS_TEAM_DOMAIN).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return "https://" + (t.includes(".") ? t : t + ".cloudflareaccess.com");
}

function b64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function signingKeys(team, refresh) {
  if (!refresh && accessKeys.team === team && Date.now() - accessKeys.at < 3600e3) return accessKeys.keys;
  const r = await fetch(team + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("certs " + r.status);
  const { keys = [] } = await r.json();
  accessKeys = { team, at: Date.now(), keys };
  return keys;
}

async function verifyAccess(req, env) {
  const cookie = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = req.headers.get("Cf-Access-Jwt-Assertion") || (cookie && cookie[1]);
  if (!token) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== "RS256") return null;

  const team = teamUrl(env);
  let jwk = (await signingKeys(team)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(team, true)).find(k => k.kid === header.kid); // keys rotated
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(h + "." + p));
  if (!ok) return null;

  const t = now();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(String(env.ACCESS_AUD).trim())) return null;
  if (claims.iss !== team) return null;
  if (!claims.exp || claims.exp < t || (claims.nbf && claims.nbf > t + 60)) return null;
  return { email: claims.email || "", sub: claims.sub || "" };
}
