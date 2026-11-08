// Slab Scan lookup server (Cloudflare Worker).
// Holds the PCGS / Greysheet credentials so they never ship to the phone.
//
// Secrets (set with `wrangler secret put NAME`):
//   APP_KEY            passcode the app sends in X-App-Key
//   PCGS_TOKEN         bearer token from your PCGS account's Public API page
//   GREYSHEET_TOKEN    optional, CDN API x-api-token
//   GREYSHEET_KEY      optional, CDN API x-api-key

const PCGS = "https://api.pcgs.com/publicapi";
const CDN = "https://cpgpublicapiv2.greysheet.com/api";

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const isApi = url.pathname === "/health" || url.pathname === "/lookup" || url.pathname === "/status"
      || url.pathname.startsWith("/greysheet/");
    // When deployed from the repo, the same Worker also serves the phone app (docs/).
    if (!isApi && env.ASSETS) return env.ASSETS.fetch(req);
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/status") {
      // Open the Worker URL in a browser to confirm it's running and configured.
      return json({
        ok: true, app: "Slab Scan lookup server",
        appKeySet: Boolean(env.APP_KEY), pcgsTokenSet: Boolean(env.PCGS_TOKEN),
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
        }, 200, cors);
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

// The APP_KEY passcode is what protects the server, so any origin may call it.
// (ALLOWED_ORIGIN is no longer required; a typo there used to block the app.)
function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "X-App-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
