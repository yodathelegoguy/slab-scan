/* Slab Scan: scan graded-coin slabs, look them up, build a spreadsheet. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const STORE = "slabscan.coins.v1";
  const CFG = "slabscan.config.v1";

  // ---------- storage ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Could not save: storage is full or blocked."); } };
  let coins = load(STORE, []);
  let cfg = load(CFG, { proxy: "", appKey: "", service: "auto" });
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

  // ---------- tabs ----------
  $$(".tab").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  function showView(v) {
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    if (v !== "scan") stopScan();
    if (v === "list") renderList();
  }

  // ---------- service picker ----------
  function setService(s) {
    cfg.service = s; save(CFG, cfg);
    $$(".seg").forEach(b => b.classList.toggle("active", b.dataset.service === s));
  }
  $$(".seg").forEach(b => b.addEventListener("click", () => setService(b.dataset.service)));
  setService(cfg.service || "auto");

  // ---------- scanner ----------
  let scanner = null, scanning = false;
  async function startScan() {
    if (!window.Html5Qrcode) { toast("Scanner failed to load."); return; }
    $("#result").classList.add("hidden");
    $("#reader-idle").classList.add("hidden");
    $("#stop-scan").classList.remove("hidden");
    const F = window.Html5QrcodeSupportedFormats;
    scanner = scanner || new Html5Qrcode("reader", {
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.QR_CODE, F.DATA_MATRIX, F.PDF_417, F.ITF],
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    });
    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.55, w * 0.6)) }), aspectRatio: 1.333 },
        text => { if (scanning) { scanning = false; buzz(); stopScan().then(() => handleCode(text)); } },
        () => {}
      );
      scanning = true;
    } catch (e) {
      resetReader();
      toast(/Permission|NotAllowed/i.test(String(e)) ? "Camera access was denied. Allow it in Settings > Safari > Camera." : "Could not start the camera.");
    }
  }
  async function stopScan() {
    scanning = false;
    if (scanner && scanner.isScanning) { try { await scanner.stop(); } catch {} }
    resetReader();
  }
  function resetReader() {
    $("#reader-idle").classList.remove("hidden");
    $("#stop-scan").classList.add("hidden");
  }
  $("#start-scan").addEventListener("click", startScan);
  $("#stop-scan").addEventListener("click", stopScan);
  $("#manual").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("#manual-input").value.trim();
    if (v) { stopScan(); handleCode(v); }
  });

  // ---------- lookup ----------
  async function apiLookup(parsed) {
    if (!cfg.proxy) return { ok: false, error: "No lookup server set. Add one in Settings to pull coin details automatically.", offline: true };
    const q = new URLSearchParams({ service: parsed.service || "PCGS" });
    if (parsed.kind === "cert") q.set("cert", parsed.cert); else q.set("barcode", parsed.raw);
    try {
      const r = await fetch(cfg.proxy + "/lookup?" + q, { headers: { "X-App-Key": cfg.appKey } });
      const d = await r.json().catch(() => ({ ok: false, error: `Server returned HTTP ${r.status}` }));
      return d;
    } catch (e) {
      return { ok: false, error: "Could not reach the lookup server. Check the URL and your connection." };
    }
  }

  async function handleCode(raw) {
    const parsed = parseScan(raw, cfg.service);
    if (!parsed.service && cfg.service === "auto") parsed.service = "PCGS";
    const card = $("#result");
    card.classList.remove("hidden");
    card.innerHTML = `<p class="muted">Looking up <b>${esc(parsed.cert || parsed.raw)}</b>…</p>`;
    let res = await apiLookup(parsed);
    // An unknown long barcode might be NGC: retry once if PCGS found nothing and the user chose Auto.
    if (!res.ok && !res.offline && parsed.kind === "barcode" && cfg.service === "auto" && parsed.service === "PCGS") {
      const alt = await apiLookup({ ...parsed, service: "NGC" });
      if (alt.ok) { res = alt; parsed.service = "NGC"; }
    }
    const coin = res.ok ? res.coin : {
      service: parsed.service, certNo: parsed.cert || "", name: "", grade: "",
    };
    coin.service = coin.service || parsed.service;
    coin.certNo = coin.certNo || parsed.cert || "";
    coin.rawCode = parsed.raw;
    renderResult(coin, res);
  }

  function renderResult(coin, res) {
    const card = $("#result");
    const vurl = verifyUrl(coin.service, coin.certNo);
    const dup = coins.find(c => c.service === coin.service && c.certNo && c.certNo === coin.certNo);
    const facts = [
      ["Service", coin.service], ["Cert #", coin.certNo], ["PCGS #", coin.pcgsNo],
      ["Grade", [coin.grade, coin.designation].filter(Boolean).join(" ")], ["Variety", coin.variety],
      ["Series", coin.series], ["Mintage", coin.mintage && Number(coin.mintage).toLocaleString()],
      ["Metal", coin.metal], ["Weight", coin.weight], ["Diameter", coin.diameter], ["Designer", coin.designer],
      ["PCGS Price Guide", money(coin.priceGuide)],
      ["Population", coin.population != null ? `${coin.population}${coin.popHigher != null ? ` (${coin.popHigher} higher)` : ""}` : ""],
      ["Last auction", coin.lastAuction ? `${money(coin.lastAuction.price)} · ${esc(coin.lastAuction.auctioneer || "")} ${coin.lastAuction.date ? new Date(coin.lastAuction.date).toLocaleDateString() : ""}` : ""],
    ].filter(([, v]) => v !== "" && v != null);

    card.innerHTML = `
      ${res.ok ? "" : `<div class="notice">${esc(res.error || "Lookup failed.")} You can still fill in the details and save it.</div>`}
      ${coin.image ? `<img class="coin-img" src="${esc(coin.image)}" alt="Coin photo" referrerpolicy="no-referrer">` : ""}
      <h2 class="coin-name">${esc(coin.name || "Unknown coin")}</h2>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${k === "Last auction" ? v : esc(v)}</dd>`).join("")}</dl>
      <div class="links">
        ${vurl ? `<a href="${vurl}" target="_blank" rel="noopener">Verify on ${esc(coin.service)}</a>` : ""}
        ${coin.coinFactsLink ? `<a href="${esc(coin.coinFactsLink)}" target="_blank" rel="noopener">PCGS CoinFacts</a>` : ""}
        <a href="https://www.greysheet.com/" target="_blank" rel="noopener">Open Greysheet</a>
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
        paid: num(f.get("paid")),
        cac: f.get("cac") || "",
        notes: f.get("notes") || "",
      };
      coins.unshift(entry); save(STORE, coins); updateCount();
      toast("Added to collection");
      card.classList.add("hidden");
      $("#manual-input").value = "";
      startScan();
    });
    $("#scan-next").addEventListener("click", () => { card.classList.add("hidden"); startScan(); });
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- collection ----------
  function updateCount() { $("#count").textContent = coins.length; }
  function renderList() {
    updateCount();
    $("#empty").classList.toggle("hidden", coins.length > 0);
    const sum = k => coins.reduce((a, c) => a + (num(c[k]) || 0), 0);
    $("#totals").innerHTML = coins.length ? `
      <div><span>${coins.length}</span>coins</div>
      <div><span>${money(sum("greysheet")) || "$0"}</span>Greysheet</div>
      <div><span>${money(sum("priceGuide")) || "$0"}</span>PCGS guide</div>
      <div><span>${money(sum("paid")) || "$0"}</span>Paid</div>` : "";
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
          </span>
        </div>
        <div class="actions">
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
    ["Mintage", c => c.mintage], ["Metal", c => c.metal], ["Notes", c => c.notes],
    ["Verify Link", c => verifyUrl(c.service, c.certNo) || ""], ["Scanned Code", c => c.rawCode],
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
    const money$ = ["Greysheet Bid", "PCGS Price Guide", "Price Paid"].map(h => COLUMNS.findIndex(c => c[0] === h));
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

  updateCount();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
