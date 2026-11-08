// Melt value: how much precious metal a coin holds and what it's worth at live spot.
// Metal content comes from, in order: what the user set on the coin, the PCGS
// "MetalContent" + "Weight" fields, then a table of common US coins.
(function (global) {
  const TROY_OZ_G = 31.1034768;
  const METALS = ["gold", "silver", "platinum", "palladium"];
  const LABEL = { gold: "Gold", silver: "Silver", platinum: "Platinum", palladium: "Palladium" };
  const SPOT_KEY = "slabscan.spot.v1";
  const SPOT_MAX_AGE = 10 * 60 * 1000; // refresh spot after 10 minutes
  const DIRECT = "https://api.gold-api.com/price/"; // free, no key; used when no lookup server is set

  // ---------- parse PCGS fields ----------
  // MetalContent looks like "90% Silver, 10% Copper" or ".999 Silver"; Weight like "26.73 grams".
  function parseFractions(text) {
    const s = String(text || "").toLowerCase();
    const out = {};
    for (const m of METALS) {
      const pct = s.match(new RegExp("(\\d{1,3}(?:\\.\\d+)?)\\s*%\\s*(?:fine\\s+)?" + m))
        || s.match(new RegExp(m + "\\s*[:\\-]?\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*%"));
      const fine = s.match(new RegExp("(?:^|[^\\d])(0?\\.\\d{2,4}|\\d{3,4})\\s*(?:fine\\s+)?" + m));
      if (pct) out[m] = parseFloat(pct[1]) / 100;
      else if (fine) { const v = fine[1].startsWith(".") || fine[1].startsWith("0.") ? parseFloat(fine[1]) : parseFloat(fine[1]) / 1000; out[m] = v; }
      else if (new RegExp("^\\s*(pure\\s+|fine\\s+)?" + m + "\\s*$").test(s)) out[m] = 0.999;
    }
    for (const k in out) if (!(out[k] > 0 && out[k] <= 1)) delete out[k];
    return out;
  }
  function parseGrams(text) {
    const s = String(text ?? "").toLowerCase().replace(/,/g, "");
    const m = s.match(/(\d+(?:\.\d+)?)\s*(troy\s*oz|ozt|oz|ounces?|grains?|g|gr|grams?)?/);
    if (!m) return null;
    const n = parseFloat(m[1]), u = m[2] || "g";
    if (/^grain/.test(u)) return n * 0.0647989;
    if (/oz|ounce/.test(u)) return n * TROY_OZ_G;
    return n;
  }

  // ---------- common US coins (actual precious metal weight, troy oz) ----------
  // Used when PCGS doesn't give metal + weight (NGC-only entries, typed coins).
  function fromTable(c) {
    const t = [c.name, c.series, c.denomination, c.metal].filter(Boolean).join(" ").toLowerCase();
    const year = parseInt(c.year || (String(c.name || "").match(/\b(1[789]\d\d|20\d\d)\b/) || [])[1]) || 0;
    const has = re => re.test(t);
    const g = oz => ({ metal: "gold", oz }), s = oz => ({ metal: "silver", oz }), p = oz => ({ metal: "platinum", oz });
    const frac = () => has(/1\/10|tenth|\$5\b/) ? 0.1 : has(/1\/4|quarter.ounce|\$10\b/) ? 0.25 : has(/1\/2|half.ounce|\$25\b/) ? 0.5 : 1;

    // Modern bullion
    if (has(/silver eagle|\bkookaburra|maple leaf.*silver|silver maple|britannia.*silver|philharmonic.*silver|libertad.*silver|america the beautiful 5 oz|atb 5 ?oz/)) {
      if (has(/5 ?oz|america the beautiful 5|atb/)) return s(5);
      return s(1);
    }
    if (has(/gold buffalo|buffalo.*\$50|\$50.*buffalo/)) return g(1);
    if (has(/gold eagle|american eagle.*gold|\bage\b/)) return g(frac());
    if (has(/platinum eagle|american eagle.*platinum/)) return p(frac());
    if (has(/krugerrand|gold maple|maple leaf.*gold|britannia.*gold|philharmonic.*gold/)) return g(frac());

    // Classic US gold (pre-1934): 90% gold
    if (has(/double eagle|\$20\b|twenty dollar/)) return g(0.9675);
    if (has(/half eagle|\$5\b|five dollar/) && year && year < 1930) return g(0.24187);
    if (has(/quarter eagle|\$2\.?50?\b|\$2 1\/2/) && year && year < 1930) return g(0.12094);
    if (has(/\beagle\b|\$10\b|ten dollar/) && !has(/half eagle|quarter eagle/) && year && year < 1934) return g(0.48375);
    if (has(/three dollar|\$3\b/)) return g(0.14512);
    if (has(/gold dollar|\bg\$1\b/)) return g(0.04837);

    // US silver
    if (has(/morgan|peace dollar|trade dollar|seated.*dollar|liberty seated dollar/)) return s(has(/trade/) ? 0.78735 : 0.77344);
    if (has(/eisenhower|\bike\b/) && has(/silver|40%|\bs\b|-s\b/) && year >= 1971 && year <= 1976) return s(0.31625);
    if (has(/half dollar|50c|\bhalf\b/) && year) {
      if (year <= 1964 && year >= 1892) return s(0.36169);
      if (year >= 1965 && year <= 1970 && has(/kennedy/)) return s(0.14792);
      if (has(/silver/) && year >= 1992) return s(0.36169); // silver proof Kennedys
    }
    if (has(/quarter|25c/) && year) {
      if (year <= 1964 && year >= 1892) return s(0.18084);
      if (has(/silver/) && year >= 1992 && year <= 2018) return s(0.18084);
      if (has(/silver/) && year >= 2019) return s(0.19290); // .999 silver proofs
    }
    if (has(/\bdime|10c/) && year) {
      if (year <= 1964 && year >= 1892) return s(0.07234);
      if (has(/silver/) && year >= 1992 && year <= 2018) return s(0.07234);
      if (has(/silver/) && year >= 2019) return s(0.07716);
    }
    // Wartime nickels: every 1943-45, and 1942-P / 1942-S.
    if (has(/nickel|\b5c\b|jefferson/) && !has(/buffalo|indian|liberty|shield/) &&
        ((year >= 1943 && year <= 1945) || (year === 1942 && has(/1942-[ps]\b|silver|wartime/)))) return s(0.05626);
    return null;
  }

  // Returns { metal, oz, source } or null. A coin's own meltMetal/meltOz wins.
  function contentFor(c) {
    if (!c) return null;
    if (c.meltMetal === "none") return null;
    if (c.meltMetal && Number(c.meltOz) > 0) return { metal: c.meltMetal, oz: Number(c.meltOz), source: "manual" };
    const fr = parseFractions(c.metal);
    const grams = parseGrams(c.weight);
    if (grams) {
      // Use the main precious metal (largest fraction by value is close enough to largest fraction).
      const best = Object.entries(fr).sort((a, b) => b[1] - a[1])[0];
      if (best) return { metal: best[0], oz: +(grams * best[1] / TROY_OZ_G).toFixed(5), source: "pcgs" };
    }
    const t = fromTable(c);
    return t ? { ...t, source: "table" } : null;
  }

  // ---------- spot prices ----------
  let spot = (() => { try { return JSON.parse(localStorage.getItem(SPOT_KEY)) || null; } catch { return null; } })();
  let inflight = null;
  const listeners = [];
  function saveSpot(s) { spot = s; try { localStorage.setItem(SPOT_KEY, JSON.stringify(s)); } catch {} listeners.forEach(f => { try { f(s); } catch {} }); }

  async function fetchDirect() {
    const sym = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" };
    const prices = {}; let updatedAt = null;
    await Promise.all(METALS.map(async m => {
      const r = await fetch(DIRECT + sym[m]); if (!r.ok) return;
      const d = await r.json();
      if (typeof d.price === "number") { prices[m] = d.price; if (!updatedAt || d.updatedAt > updatedAt) updatedAt = d.updatedAt; }
    }));
    return { ok: Object.keys(prices).length > 0, prices, updatedAt, source: "gold-api.com" };
  }
  // proxy: the lookup server URL (optional). Falls back to calling gold-api.com directly.
  function refresh(proxy, force) {
    if (!force && spot && Date.now() - spot.fetchedAt < SPOT_MAX_AGE) return Promise.resolve(spot);
    if (inflight) return inflight;
    inflight = (async () => {
      let d = null;
      if (proxy) { try { const r = await fetch(proxy + "/spot"); d = await r.json(); } catch {} }
      if (!d || !d.ok) { try { d = await fetchDirect(); } catch {} }
      if (d && d.ok) saveSpot({ prices: d.prices, updatedAt: d.updatedAt || new Date().toISOString(), fetchedAt: Date.now() });
      return spot;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function value(c, s = spot) {
    const ct = contentFor(c);
    if (!ct || !s || !s.prices || typeof s.prices[ct.metal] !== "number") return null;
    return Math.round(ct.oz * s.prices[ct.metal] * 100) / 100;
  }

  global.Melt = {
    METALS, LABEL, contentFor, value, refresh, parseFractions, parseGrams, fromTable,
    get spot() { return spot; },
    onUpdate(f) { listeners.push(f); },
  };
  if (typeof module !== "undefined") module.exports = global.Melt;
})(typeof window !== "undefined" ? window : globalThis);
