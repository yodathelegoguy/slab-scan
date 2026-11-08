/* Slab Scan: scan graded-coin slabs, look them up, build a spreadsheet. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const STORE = "slabscan.coins.v1";
  const CFG = "slabscan.config.v1";
  const GS_LINKS = "slabscan.greysheet.v1"; // saved Greysheet page per coin type

  // ---------- storage ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Could not save: storage is full or blocked."); } };
  let coins = load(STORE, []);
  let cfg = load(CFG, { proxy: "", appKey: "", service: "auto" });
  let gsLinks = load(GS_LINKS, {});
  // Served by the Cloudflare Worker itself? Then the lookup server is this same site.
  if (!cfg.proxy && /\.workers\.dev$/i.test(location.hostname)) cfg.proxy = location.origin;

  // ---------- helpers ----------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => (n === null || n === undefined || n === "" || isNaN(n)) ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const num = v => { const n = parseFloat(String(v).replace(/[$,\s]/g, "")); return isNaN(n) ? null : n; };
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function buzz() {
    try { navigator.vibrate && navigator.vibrate(60); } catch {}
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 1200; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.08);
    } catch {}
  }

  // ---------- Greysheet links ----------
  // Greysheet has no public lookup by PCGS number, so the first time a coin type
  // is seen we open a web search limited to greysheet.com. Once Carson saves the
  // right page it is remembered for that PCGS # and opened directly next time.
  const gsKey = c => c.pcgsNo ? "pcgs:" + c.pcgsNo : (c.name ? "name:" + c.name.trim().toLowerCase() : "");
  const gsSaved = c => (gsKey(c) && gsLinks[gsKey(c)]) || c.greysheetUrl || "";
  function gsQuery(c) {
    const name = String(c.name || "").trim();
    const series = c.series && !name.toLowerCase().includes(String(c.series).toLowerCase()) ? c.series : "";
    return [name, series, c.designation].filter(Boolean).join(" ");
  }
  function greysheetUrl(c) {
    const saved = gsSaved(c); if (saved) return saved;
    const q = gsQuery(c);
    return q ? "https://www.google.com/search?q=" + encodeURIComponent("site:greysheet.com " + q) : "https://www.greysheet.com/prices";
  }
  const isGsUrl = u => /^https:\/\/([a-z0-9-]+\.)?greysheet\.com\//i.test(u);
  function saveGreysheetLink(c) {
    const v = prompt("Paste the Greysheet page link for " + (c.name || "this coin") +
      "\n(In Safari: Share, then Copy. Leave empty to forget the saved link.)", gsSaved(c));
    if (v === null) return false;
    const url = v.trim(); const key = gsKey(c);
    if (url && !isGsUrl(url)) { toast("That isn't a greysheet.com link."); return false; }
    if (key) { if (url) gsLinks[key] = url; else delete gsLinks[key]; save(GS_LINKS, gsLinks); }
    c.greysheetUrl = url;
    coins.forEach(x => { if (key && gsKey(x) === key) x.greysheetUrl = url; }); save(STORE, coins);
    toast(url ? "Greysheet page saved for this coin" : "Saved Greysheet page removed");
    return true;
  }

  // ---------- melt value (see melt.js) ----------
  const hasMelt = () => typeof window.Melt !== "undefined";
  const ozText = oz => (+oz).toFixed(oz >= 1 ? 3 : 4).replace(/0+$/, "").replace(/\.$/, "");
  function meltValue(c) { return hasMelt() ? Melt.value(c) : null; }
  function meltText(c) {
    if (!hasMelt()) return "";
    const ct = Melt.contentFor(c); if (!ct) return "";
    const v = Melt.value(c), p = Melt.spot && Melt.spot.prices && Melt.spot.prices[ct.metal];
    const what = `${ozText(ct.oz)} oz ${ct.metal}`;
    return v != null ? `${money(v)} (${what} at ${money(p)})` : `${what} (spot not loaded yet)`;
  }
  function spotStrip() {
    const sp = hasMelt() && Melt.spot; if (!sp || !sp.prices) return "";
    const when = sp.updatedAt ? new Date(sp.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const ago = Date.now() - (sp.fetchedAt || 0) > 3600e3 ? " (offline, last known)" : "";
    return Melt.METALS.filter(m => typeof sp.prices[m] === "number")
      .map(m => `<span>${Melt.LABEL[m]} <b>${money(sp.prices[m])}</b></span>`).join("") +
      `<span class="muted">Spot ${esc(when)}${ago}</span>`;
  }
  function refreshSpot(force) {
    if (!hasMelt()) return Promise.resolve(null);
    return Melt.refresh(cfg.proxy, force).catch(() => null);
  }
  if (hasMelt()) Melt.onUpdate(() => {
    if ($("#view-list").classList.contains("active")) renderList();
    const mf = $("#melt-fact"); if (mf && currentCoin) mf.textContent = meltText(currentCoin);
  });
  let currentCoin = null;

  // ---------- tabs ----------
  $$(".tab").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  function showView(v) {
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    if (v !== "scan") stopScan();
    if (v === "list") { renderList(); refreshSpot(); }
  }

  // ---------- service picker ----------
  function setService(s) {
    cfg.service = s; save(CFG, cfg);
    $$(".seg").forEach(b => b.classList.toggle("active", b.dataset.service === s));
  }
  $$(".seg").forEach(b => b.addEventListener("click", () => setService(b.dataset.service)));
  setService(cfg.service || "auto");

  // ---------- scanner ----------
  let live = null;
  const status = msg => { const el = $("#scan-status"); el.textContent = msg || ""; el.classList.toggle("hidden", !msg); };
  window.SlabScanner && SlabScanner.init().catch(() => {}); // warm up the decoder

  async function startScan() {
    if (!window.SlabScanner) { toast("Scanner failed to load. Check your connection and reopen the app."); return; }
    if (live && live.running) return;
    $("#result").classList.add("hidden");
    $("#reader-idle").classList.add("hidden");
    $("#guide").classList.remove("hidden");
    $("#cam-controls").classList.remove("hidden");
    status("Starting camera…");
    live = new SlabScanner.LiveScanner({
      video: $("#video"),
      onStatus: status,
      onResult: text => { buzz(); resetReader(); handleCode(text); },
    });
    try {
      const caps = await live.start();
      // Zoom lets you hold the slab farther away, where the camera can focus.
      if (caps.zoom && caps.zoom.max > 1) {
        const z = $("#zoom"); z.min = caps.zoom.min || 1; z.max = Math.min(caps.zoom.max, 8); z.step = caps.zoom.step || 0.1;
        const start = Math.min(2, z.max); z.value = start; $("#zoom-val").textContent = (+start).toFixed(1) + "×";
        live.setZoom(start);
        $("#zoom-wrap").classList.remove("hidden");
      } else $("#zoom-wrap").classList.add("hidden");
      $("#torch").classList.toggle("hidden", !caps.torch);
      setTimeout(() => { if (live && live.running) status("Tip: back up a little and zoom in, or tap Photo."); }, 9000);
    } catch (e) {
      resetReader();
      toast(/Permission|NotAllowed/i.test(String(e && e.name || e)) ? "Camera access was denied. Allow it in Settings > Safari > Camera." : "Could not start the camera. Try Photo instead.");
    }
  }
  async function stopScan() {
    if (live) live.stop();
    resetReader();
  }
  function resetReader() {
    $("#reader-idle").classList.remove("hidden");
    $("#guide").classList.add("hidden");
    $("#cam-controls").classList.add("hidden");
    torchOn = false; $("#torch").classList.remove("on");
    status("");
  }
  let torchOn = false;
  $("#torch").addEventListener("click", async () => {
    if (!live) return;
    torchOn = !torchOn;
    if (await live.setTorch(torchOn)) $("#torch").classList.toggle("on", torchOn);
  });
  $("#zoom").addEventListener("input", e => {
    $("#zoom-val").textContent = (+e.target.value).toFixed(1) + "×";
    live && live.setZoom(+e.target.value);
  });
  $("#start-scan").addEventListener("click", startScan);
  $("#stop-scan").addEventListener("click", stopScan);

  // Photo fallback: the native camera focuses and exposes better than the live preview.
  async function onPhoto(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    await stopScan();
    $("#reader-idle").classList.add("hidden");
    status("Reading barcode from photo…");
    try {
      const text = await SlabScanner.decodeFile(file);
      resetReader();
      if (text) { buzz(); handleCode(text); }
      else toast("No barcode found. Make sure the barcode is sharp (back up a bit if it looks blurry) and fills a good part of the photo.");
    } catch (err) { resetReader(); toast("Could not read that photo."); }
  }
  $("#photo-input").addEventListener("change", onPhoto);
  $("#photo-input-2").addEventListener("change", onPhoto);
  $("#manual").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("#manual-input").value.trim();
    if (v) { stopScan(); handleCode(v); }
  });

  // ---------- lookup ----------
  // ---------- PCGS call budget ----------
  const CACHE_KEY = "slabscan.lookups.v1", USAGE_KEY = "slabscan.usage.v1";
  let lookupCache = load(CACHE_KEY, {});
  const today = () => new Date().toLocaleDateString("en-CA");
  function usedToday() { const u = load(USAGE_KEY, {}); return u.day === today() ? u.calls : 0; }
  function addUsage(n) {
    if (!n) return;
    const u = load(USAGE_KEY, {}); const d = today();
    save(USAGE_KEY, { day: d, calls: (u.day === d ? u.calls : 0) + n });
    renderUsage();
  }
  const dailyLimit = () => cfg.dailyLimit || 100;
  function usageText() { return `PCGS lookups today: ${usedToday()} of ${dailyLimit()}`; }
  function renderUsage() { const el = $("#usage"); if (el) el.textContent = usageText(); }
  const cacheKeys = p => [p.cert && `${p.service}:c:${p.cert}`, p.raw && `${p.service}:r:${p.raw}`].filter(Boolean);
  function fromMemory(p) {
    // A coin already in the collection, or looked up before, costs nothing.
    if (p.cert) {
      const c = coins.find(x => x.service === p.service && x.certNo === p.cert && (x.name || x.pcgsNo));
      if (c) return { ...c };
    }
    for (const k of cacheKeys(p)) if (lookupCache[k]) return { ...lookupCache[k] };
    return null;
  }
  function remember(p, coin) {
    for (const k of cacheKeys(p)) lookupCache[k] = coin;
    if (coin.certNo) lookupCache[`${p.service}:c:${coin.certNo}`] = coin;
    const keys = Object.keys(lookupCache);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach(k => delete lookupCache[k]);
    save(CACHE_KEY, lookupCache);
  }

  async function apiLookup(parsed, mode) {
    if (!cfg.proxy) return { ok: false, error: "No lookup server set. Add one in Settings to pull coin details automatically.", offline: true };
    if (!mode) {
      const mem = fromMemory(parsed);
      if (mem) return { ok: true, coin: mem, cached: true };
    }
    const q = new URLSearchParams({ service: parsed.service || "PCGS" });
    if (mode) q.set("mode", mode);
    if (parsed.cert) q.set("cert", parsed.cert);
    if (parsed.raw && parsed.raw !== parsed.cert) q.set("barcode", parsed.raw);
    try {
      const r = await fetch(cfg.proxy + "/lookup?" + q, { headers: { "X-App-Key": cfg.appKey } });
      const d = await r.json().catch(() => ({ ok: false, error: `Server returned HTTP ${r.status}` }));
      addUsage(d.calls || 0);
      if (d.ok && d.coin) remember(parsed, d.coin);
      return d;
    } catch (e) {
      return { ok: false, error: "Could not reach the lookup server. Check the URL and your connection." };
    }
  }

  async function handleCode(raw, mode) {
    const parsed = parseScan(raw, cfg.service);
    if (!parsed.service && cfg.service === "auto") parsed.service = "PCGS";
    const card = $("#result");
    card.classList.remove("hidden");
    let res;
    const mem = mode ? null : fromMemory(parsed);
    if (mem) res = { ok: true, coin: mem, cached: true };
    else if (!mode && cfg.autoLookup === false) res = { ok: false, deferred: true, error: "Automatic lookups are off, so no PCGS lookup was used." };
    else if (!cfg.proxy) res = await apiLookup(parsed);
    else {
      card.innerHTML = `<p class="muted">Looking up <b>${esc(parsed.cert || parsed.raw)}</b>…</p>`;
      res = await apiLookup(parsed, mode === "single" ? undefined : mode);
    }
    const coin = res.ok ? res.coin : {
      service: parsed.service, certNo: parsed.cert || "", name: "", grade: "",
    };
    coin.service = coin.service || parsed.service;
    coin.certNo = coin.certNo || parsed.cert || "";
    coin.rawCode = parsed.raw;
    renderResult(coin, res, raw);
  }

  // Optional metal content override, for coins PCGS has no metal data for.
  function meltFields(c) {
    if (!hasMelt()) return "";
    const ct = Melt.contentFor(c);
    const opts = [["", ct ? `Auto (${ozText(ct.oz)} oz ${ct.metal})` : "Auto (none found)"],
      ...Melt.METALS.map(m => [m, Melt.LABEL[m]]), ["none", "No melt value"]];
    return `<details class="melt-edit"><summary>Metal content for melt value</summary>
      <div class="grid2">
        <label>Metal<select name="meltMetal">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
        <label>Pure metal (troy oz)<input name="meltOz" inputmode="decimal" placeholder="${ct ? ozText(ct.oz) : "e.g. 0.7734"}"></label>
      </div></details>`;
  }
  function meltFromForm(f, c) {
    const metal = f.get("meltMetal") || "", oz = num(f.get("meltOz"));
    if (metal === "none") return { meltMetal: "none", meltOz: null };
    if (!metal && oz == null) return {};
    const auto = hasMelt() ? Melt.contentFor({ ...c, meltMetal: "", meltOz: null }) : null;
    const m = metal || (auto && auto.metal) || "silver";
    const o = oz != null ? oz : (auto && auto.metal === m ? auto.oz : null);
    return o > 0 ? { meltMetal: m, meltOz: o } : {};
  }

  function renderResult(coin, res, raw) {
    const card = $("#result");
    currentCoin = coin; refreshSpot();
    const vurl = verifyUrl(coin.service, coin.certNo);
    const dup = coins.find(c => c.service === coin.service && c.certNo && c.certNo === coin.certNo);
    const facts = [
      ["Service", coin.service], ["Cert #", coin.certNo], ["PCGS #", coin.pcgsNo],
      ["Grade", [coin.grade, coin.designation].filter(Boolean).join(" ")], ["Variety", coin.variety],
      ["Series", coin.series], ["Mintage", coin.mintage && Number(coin.mintage).toLocaleString()],
      ["Metal", coin.metal], ["Weight", coin.weight], ["Diameter", coin.diameter], ["Designer", coin.designer],
      ["Melt value", meltText(coin)],
      ["PCGS Price Guide", money(coin.priceGuide)],
      ["Population", coin.population != null ? `${coin.population}${coin.popHigher != null ? ` (${coin.popHigher} higher)` : ""}` : ""],
      ["Last auction", coin.lastAuction ? `${money(coin.lastAuction.price)} · ${esc(coin.lastAuction.auctioneer || "")} ${coin.lastAuction.date ? new Date(coin.lastAuction.date).toLocaleDateString() : ""}` : ""],
    ].filter(([, v]) => v !== "" && v != null);

    card.innerHTML = `
      ${res.deferred ? `<div class="notice"><b>Not looked up yet.</b> ${esc(res.error)}
        <div class="row"><button type="button" class="primary" id="lookup-now">Look up now (1 PCGS lookup)</button></div></div>` : ""}
      ${res.ok || res.deferred ? "" : `<div class="notice error"><b>No coin details found.</b> ${esc(res.error || "Lookup failed.")}
        ${res.canTryHarder ? `<div class="row"><button type="button" id="try-harder">Try other ways (up to 3 lookups)</button></div>` : ""}
        <details><summary>What was scanned</summary>
          <p>Scanned text: <code>${esc(coin.rawCode || "")}</code></p>
          ${(res.attempts || []).map(a => `<p><code>${esc(a.try)}</code> → ${esc(a.status != null ? "HTTP " + a.status + ": " : "")}${esc(a.result)}</p>`).join("")}
        </details></div>`}
      ${coin.image ? `<img class="coin-img" src="${esc(coin.image)}" alt="Coin photo" referrerpolicy="no-referrer">` : ""}
      <h2 class="coin-name">${esc(coin.name || "Unknown coin")}</h2>
      <p class="muted small">${res.cached ? "Already looked up before, so no PCGS lookup was used. " : ""}${cfg.proxy ? esc(usageText()) : ""}</p>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd${k === "Melt value" ? ' id="melt-fact"' : ""}>${k === "Last auction" ? v : esc(v)}</dd>`).join("")}</dl>
      <div class="links">
        ${vurl ? `<a href="${vurl}" target="_blank" rel="noopener">Verify on ${esc(coin.service)}</a>` : ""}
        ${coin.coinFactsLink ? `<a href="${esc(coin.coinFactsLink)}" target="_blank" rel="noopener">PCGS CoinFacts</a>` : ""}
        <a href="${esc(greysheetUrl(coin))}" target="_blank" rel="noopener" class="gs-link">${gsSaved(coin) ? "Open Greysheet page" : "Find on Greysheet"}</a>
        <button type="button" id="gs-save" class="link-btn">${gsSaved(coin) ? "Change Greysheet page" : "Save Greysheet page"}</button>
      </div>
      <form id="add-form" class="add-form">
        ${res.ok ? "" : `
          <label>Coin description<input name="name" value="${esc(coin.name)}" placeholder="e.g. 1881-S Morgan Dollar"></label>
          <label>Grade<input name="grade" value="${esc(coin.grade)}" placeholder="e.g. MS65"></label>`}
        <div class="grid2">
          <label>Greysheet bid<input name="greysheet" inputmode="decimal" placeholder="$"></label>
          <label>Price paid<input name="paid" inputmode="decimal" placeholder="$"></label>
        </div>
        <label>CAC?<select name="cac"><option value="">No</option><option>Green</option><option>Gold</option></select></label>
        <label>Notes<input name="notes" placeholder="Where bought, toning, etc."></label>
        ${meltFields(coin)}
        ${dup ? `<p class="notice">This cert is already in your collection.</p>` : ""}
        <div class="row">
          <button type="submit" class="primary big">${dup ? "Add again" : "Add to collection"}</button>
          <button type="button" id="scan-next">Scan next</button>
        </div>
      </form>`;
    $("#add-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        addedAt: new Date().toISOString(),
        ...coin,
        name: f.get("name") ?? coin.name,
        grade: f.get("grade") ?? coin.grade,
        greysheet: num(f.get("greysheet")),
        greysheetUrl: gsSaved(coin),
        paid: num(f.get("paid")),
        cac: f.get("cac") || "",
        notes: f.get("notes") || "",
        ...meltFromForm(f, coin),
      };
      coins.unshift(entry); save(STORE, coins); updateCount();
      toast("Added to collection");
      card.classList.add("hidden");
      $("#manual-input").value = "";
      startScan();
    });
    $("#scan-next").addEventListener("click", () => { card.classList.add("hidden"); startScan(); });
    $("#gs-save").addEventListener("click", () => {
      if (!saveGreysheetLink(coin)) return;
      const a = $(".gs-link", card); a.href = greysheetUrl(coin);
      a.textContent = gsSaved(coin) ? "Open Greysheet page" : "Find on Greysheet";
      $("#gs-save").textContent = gsSaved(coin) ? "Change Greysheet page" : "Save Greysheet page";
    });
    const th = $("#try-harder"); if (th) th.addEventListener("click", () => handleCode(raw || coin.rawCode, "deep"));
    const ln = $("#lookup-now"); if (ln) ln.addEventListener("click", () => handleCode(raw || coin.rawCode, "single"));
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- collection ----------
  function updateCount() { $("#count").textContent = coins.length; }
  function renderList() {
    updateCount(); renderFill();
    $("#empty").classList.toggle("hidden", coins.length > 0);
    const sum = k => coins.reduce((a, c) => a + (num(c[k]) || 0), 0);
    const meltSum = coins.reduce((a, c) => a + (meltValue(c) || 0), 0);
    const spotEl = $("#spot"); if (spotEl) spotEl.innerHTML = spotStrip();
    $("#totals").innerHTML = coins.length ? `
      <div><span>${coins.length}</span>coins</div>
      <div><span>${money(sum("greysheet")) || "$0"}</span>Greysheet</div>
      <div><span>${money(sum("priceGuide")) || "$0"}</span>PCGS guide</div>
      <div><span>${money(sum("paid")) || "$0"}</span>Paid</div>
      ${meltSum ? `<div><span>${money(meltSum)}</span>Melt</div>` : ""}` : "";
    $("#coin-list").innerHTML = coins.map(c => `
      <li class="coin" data-id="${c.id}">
        ${c.thumb ? `<img src="${esc(c.thumb)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph">${esc(c.service || "?")}</div>`}
        <div class="meta">
          <b>${esc(c.name || "Unknown coin")}</b>
          <span>${esc(c.service || "")} ${esc(c.grade || "")}${c.cac ? " · CAC " + esc(c.cac) : ""} · #${esc(c.certNo || c.rawCode || "")}</span>
          <span class="vals">
            ${c.greysheet != null ? `Grey ${money(c.greysheet)}` : ""}
            ${c.priceGuide != null ? ` · PCGS ${money(c.priceGuide)}` : ""}
            ${c.paid != null ? ` · Paid ${money(c.paid)}` : ""}
            ${meltValue(c) != null ? ` · Melt ${money(meltValue(c))}` : ""}
          </span>
        </div>
        <div class="actions">
          <a class="gs" href="${esc(greysheetUrl(c))}" target="_blank" rel="noopener" aria-label="Open on Greysheet">G</a>
          <button class="edit-grey" aria-label="Edit Greysheet value">$</button>
          <button class="del" aria-label="Delete">✕</button>
        </div>
      </li>`).join("");
  }
  $("#coin-list").addEventListener("click", e => {
    const li = e.target.closest(".coin"); if (!li) return;
    const c = coins.find(x => x.id === li.dataset.id); if (!c) return;
    if (e.target.closest(".del")) {
      if (confirm(`Remove ${c.name || "this coin"}?`)) { coins = coins.filter(x => x !== c); save(STORE, coins); renderList(); }
    } else if (e.target.closest(".edit-grey")) {
      const v = prompt("Greysheet bid for " + (c.name || "this coin"), c.greysheet ?? "");
      if (v !== null) { c.greysheet = num(v); save(STORE, coins); renderList(); }
    }
  });
  $("#clear-all").addEventListener("click", () => {
    if (coins.length && confirm("Delete every coin in the collection? Export first if you want a copy.")) {
      coins = []; save(STORE, coins); renderList();
    }
  });

  // ---------- export ----------
  const COLUMNS = [
    ["Added", c => c.addedAt ? new Date(c.addedAt).toLocaleDateString() : ""],
    ["Service", c => c.service], ["Cert #", c => c.certNo], ["PCGS #", c => c.pcgsNo],
    ["Coin", c => c.name], ["Year", c => c.year], ["Mint Mark", c => c.mintMark],
    ["Denomination", c => c.denomination], ["Grade", c => c.grade], ["Designation", c => c.designation],
    ["CAC", c => c.cac], ["Variety", c => c.variety], ["Series", c => c.series],
    ["Greysheet Bid", c => c.greysheet], ["PCGS Price Guide", c => c.priceGuide], ["Price Paid", c => c.paid],
    ["Population", c => c.population], ["Pop Higher", c => c.popHigher],
    ["Mintage", c => c.mintage], ["Metal", c => c.metal],
    ["Melt Metal", c => { const m = hasMelt() && Melt.contentFor(c); return m ? Melt.LABEL[m.metal] : ""; }],
    ["Pure Metal (oz)", c => { const m = hasMelt() && Melt.contentFor(c); return m ? m.oz : ""; }],
    ["Melt Value", c => meltValue(c)],
    ["Spot Used", c => { const m = hasMelt() && Melt.contentFor(c); const p = m && Melt.spot && Melt.spot.prices[m.metal]; return p ?? ""; }],
    ["Notes", c => c.notes],
    ["Verify Link", c => verifyUrl(c.service, c.certNo) || ""], ["Greysheet Link", c => gsSaved(c) || greysheetUrl(c)], ["Scanned Code", c => c.rawCode],
  ];
  const rows = () => coins.map(c => Object.fromEntries(COLUMNS.map(([h, f]) => [h, f(c) ?? ""])));
  const fname = ext => `coins-${new Date().toISOString().slice(0, 10)}.${ext}`;

  async function deliver(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $("#export-xlsx").addEventListener("click", () => {
    if (!coins.length) return toast("Nothing to export yet.");
    const ws = XLSX.utils.json_to_sheet(rows(), { header: COLUMNS.map(c => c[0]) });
    ws["!cols"] = COLUMNS.map(([h]) => ({ wch: h === "Coin" ? 34 : h === "Verify Link" ? 40 : Math.max(10, h.length + 2) }));
    const money$ = ["Greysheet Bid", "PCGS Price Guide", "Price Paid", "Melt Value", "Spot Used"].map(h => COLUMNS.findIndex(c => c[0] === h));
    for (let r = 1; r <= coins.length; r++) money$.forEach(ci => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })]; if (cell && cell.t === "n") cell.z = "$#,##0.00";
    });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Coins");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    deliver(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname("xlsx"));
  });
  $("#export-csv").addEventListener("click", () => {
    if (!coins.length) return toast("Nothing to export yet.");
    const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [COLUMNS.map(c => q(c[0])).join(","), ...rows().map(r => COLUMNS.map(([h]) => q(r[h])).join(","))].join("\n");
    deliver(new Blob([csv], { type: "text/csv" }), fname("csv"));
  });

  // ---------- settings ----------
  $("#proxy-url").value = cfg.proxy || "";
  $("#app-key").value = cfg.appKey || "";
  // Accepts "slab-scan.x.workers.dev", trailing slashes, or a pasted /health URL.
  function cleanUrl(v) {
    let u = String(v || "").trim().replace(/\s+/g, "");
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u.replace(/\/(health|lookup)?\/*$/i, "").replace(/\/+$/, "");
  }
  function readSettings() {
    cfg.proxy = cleanUrl($("#proxy-url").value); cfg.appKey = $("#app-key").value.trim();
    $("#proxy-url").value = cfg.proxy; save(CFG, cfg);
  }
  $("#settings-form").addEventListener("submit", e => {
    e.preventDefault(); readSettings();
    $("#settings-status").textContent = "Saved.";
  });
  $("#test-proxy").addEventListener("click", async () => {
    readSettings();
    const url = cfg.proxy;
    const st = $("#settings-status");
    if (!url) { st.textContent = "Enter a server URL first."; return; }
    st.textContent = "Testing " + url + " …";
    let r;
    try {
      r = await fetch(url + "/health", { headers: { "X-App-Key": cfg.appKey } });
    } catch (e) {
      st.textContent = `Could not reach ${url}. Check the URL is your Worker's address (ends in .workers.dev) and that you clicked Deploy after pasting the code. (${e.message})`;
      return;
    }
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch {
      st.textContent = `Reached the server, but it isn't running the Slab Scan code yet (HTTP ${r.status}: "${text.slice(0, 60)}"). Paste worker.js into the Worker and Deploy.`;
      return;
    }
    st.textContent = d.ok
      ? `Connected and saved. PCGS key: ${d.pcgs ? "set" : "MISSING"}. Greysheet key: ${d.greysheet ? "set" : "not set"}.`
      : (d.error || `HTTP ${r.status}`) + " (saved)";
  });

  // ---------- lookup settings ----------
  $("#auto-lookup").checked = cfg.autoLookup !== false;
  $("#auto-lookup").addEventListener("change", e => { cfg.autoLookup = e.target.checked; save(CFG, cfg); });
  $("#daily-limit").value = dailyLimit();
  $("#daily-limit").addEventListener("change", e => { cfg.dailyLimit = Math.max(1, parseInt(e.target.value) || 100); save(CFG, cfg); renderUsage(); });
  renderUsage();

  // ---------- fill in coins saved without details ----------
  // NGC certs typed by hand can't be looked up (no NGC API); scanned NGC barcodes can.
  const missing = () => coins.filter(c => !c.name && !c.pcgsNo &&
    (c.service === "NGC" ? (c.rawCode && c.rawCode !== c.certNo) : (c.certNo || c.rawCode)));
  function renderFill() {
    const n = missing().length, b = $("#fill-missing");
    b.classList.toggle("hidden", !n || !cfg.proxy);
    b.textContent = `Fill in missing details for ${n} coin${n === 1 ? "" : "s"} (up to ${n} PCGS lookup${n === 1 ? "" : "s"})`;
  }
  $("#fill-missing").addEventListener("click", async () => {
    const list = missing(); const left = dailyLimit() - usedToday();
    if (list.length > left && !confirm(`That could use ${list.length} lookups and you have about ${left} left today. Continue?`)) return;
    let filled = 0;
    for (const c of list) {
      $("#fill-missing").textContent = `Looking up ${filled + 1} of ${list.length}…`;
      const p = parseScan(c.rawCode || c.certNo, c.service);
      p.service = c.service || p.service;
      const res = await apiLookup(p);
      if (res.limited) { toast("PCGS limit reached. Try the rest tomorrow."); break; }
      if (res.ok && res.coin) {
        const keep = { id: c.id, addedAt: c.addedAt, greysheet: c.greysheet, paid: c.paid, cac: c.cac, notes: c.notes, rawCode: c.rawCode,
          meltMetal: c.meltMetal, meltOz: c.meltOz };
        Object.assign(c, res.coin, keep); filled++;
      }
    }
    save(STORE, coins); renderList();
    toast(`Filled in ${filled} of ${list.length}.`);
  });

  updateCount();
  refreshSpot();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
