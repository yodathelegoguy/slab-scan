// Slab Scan lookup server (Cloudflare Worker).
// Holds the PCGS / Greysheet credentials so they never ship to the phone.
//
// Secrets (set with `wrangler secret put NAME`):
//   APP_KEY            passcode the app sends in X-App-Key
//   PCGS_TOKEN         bearer token from your PCGS account's Public API page
//   GREYSHEET_TOKEN    optional, CDN API x-api-token
//   GREYSHEET_KEY      optional, CDN API x-api-key
//
// Binding (optional, turns on the shared collection):
//   DB                 a Cloudflare D1 database. The table is created on first use.

const PCGS = "https://api.pcgs.com/publicapi";
const CDN = "https://cpgpublicapiv2.greysheet.com/api";

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const isApi = url.pathname === "/health" || url.pathname === "/lookup" || url.pathname === "/status"
      || url.pathname === "/sync" || url.pathname.startsWith("/greysheet/");
    // When deployed from the repo, the same Worker also serves the phone app (docs/).
    if (!isApi && env.ASSETS) return env.ASSETS.fetch(req);
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/status") {
      // Open the Worker URL in a browser to confirm it's running and configured.
      return json({
        ok: true, app: "Slab Scan lookup server",
        appKeySet: Boolean(env.APP_KEY), pcgsTokenSet: Boolean(env.PCGS_TOKEN), syncDatabaseSet: Boolean(env.DB),
      }, 200, cors);
    }
    const sent = (req.headers.get("X-App-Key") || "").trim();
    if (!env.APP_KEY) return json({ ok: false, error: "APP_KEY is not set on the server. Add it under Settings > Variables and Secrets." }, 401, cors);
    if (sent !== String(env.APP_KEY).trim()) {
      return json({ ok: false, error: "Wrong or missing app passcode." }, 401, cors);
    }

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

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const attempts = [];
  let calls = 0;
  for (const step of steps) {
    let r, d = null, text = "";
    const cacheKey = new Request("https://slab-scan-cache.internal" + step.path);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cd = await hit.json();
        attempts.push({ try: step.label, result: "from cache (no PCGS call)" });
        return { ok: true, source: "PCGS CoinFacts (cached)", coin: normalize(cd, service), attempts, calls };
      }
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
      if (cache) {
        await cache.put(cacheKey, new Response(JSON.stringify(d), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=2592000" },
        })).catch(() => {});
      }
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
let schemaReady = false;
const PAGE = 500, MAX_PUSH = 500, MAX_DATA = 256 * 1024;

async function sync(db, body) {
  if (!schemaReady) { await db.batch(SCHEMA.map(q => db.prepare(q))); schemaReady = true; }
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
