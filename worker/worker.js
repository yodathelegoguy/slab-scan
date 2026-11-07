// Slab Scan lookup server (Cloudflare Worker).
// Holds the PCGS / Greysheet credentials so they never ship to the phone.
//
// Secrets (set with `wrangler secret put NAME`):
//   APP_KEY            passcode the app sends in X-App-Key
//   PCGS_TOKEN         bearer token from your PCGS account's Public API page
//   GREYSHEET_TOKEN    optional, CDN API x-api-token
//   GREYSHEET_KEY      optional, CDN API x-api-key
// Vars (wrangler.toml):
//   ALLOWED_ORIGIN     the URL your app is served from, e.g. https://you.github.io

const PCGS = "https://api.pcgs.com/publicapi";
const CDN = "https://cpgpublicapiv2.greysheet.com/api";

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (!env.APP_KEY || req.headers.get("X-App-Key") !== env.APP_KEY) {
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
  const cert = params.get("cert");
  const barcode = params.get("barcode");
  if (!env.PCGS_TOKEN) return { ok: false, error: "PCGS_TOKEN is not set on the server." };

  let path;
  if (barcode) {
    // PCGS decodes both PCGS and NGC holder barcodes.
    path = `/coindetail/GetCoinFactsByBarcode?barcode=${encodeURIComponent(barcode)}&gradingService=${service === "NGC" ? "NGC" : "PCGS"}`;
  } else if (cert && service === "PCGS") {
    path = `/coindetail/GetCoinFactsByCertNo/${encodeURIComponent(cert)}`;
  } else if (cert && service === "NGC") {
    // NGC has no public API; a typed NGC cert can't be decoded server-side.
    return { ok: false, error: "NGC has no public lookup API. Scan the NGC barcode instead, or open the NGC verification link.", unsupported: true };
  } else {
    return { ok: false, error: "Send cert or barcode." };
  }

  const r = await fetch(PCGS + path, { headers: { Authorization: `bearer ${env.PCGS_TOKEN}` } });
  if (r.status === 204) return { ok: false, error: "PCGS has no data for that code." };
  if (r.status === 500) return { ok: false, error: "PCGS rejected the request (usually an expired or invalid token)." };
  if (!r.ok) return { ok: false, error: `PCGS returned HTTP ${r.status}.` };
  const d = await r.json();
  if (d.IsValidRequest === false) return { ok: false, error: d.ServerMessage || "PCGS could not find that coin." };
  return { ok: true, source: "PCGS CoinFacts", coin: normalize(d, service) };
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

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : "null",
    "Access-Control-Allow-Headers": "X-App-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
