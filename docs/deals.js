/* Slab Scan: offer calculator and deals (lots bought from one seller).
 *
 * Offers are a percentage of each coin's Greysheet bid. The default percentage
 * can be overridden by category rules (a word matched against the coin's name,
 * series, denomination and metal), and per coin with a percent or a fixed price.
 *
 * A deal groups coins under a seller and date, and prints an offer sheet with
 * signature lines. Coins carry a dealId; deals live in their own storage key.
 *
 * Loaded before app.js. app.js calls SlabDeals.init(api) once it has started.
 */
(() => {
  const OFFERS = "slabscan.offers.v1";
  const DEALS = "slabscan.deals.v1";
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const num = v => { if (v === null || v === undefined || v === "") return null; const n = parseFloat(String(v).replace(/[$,%\s]/g, "")); return isNaN(n) ? null : n; };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => (n === null || n === undefined || n === "" || isNaN(n)) ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const money0 = n => money(n) || "$0.00";
  const today = () => new Date().toLocaleDateString("en-CA");
  const fmtDate = d => { if (!d) return ""; const t = new Date(d + "T12:00:00"); return isNaN(t) ? d : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Stamps the edit time sync uses for last-write-wins (see DATA-MODEL.md).
  const touch = c => { c.updatedAt = new Date().toISOString(); return c; };
  const gradeText = c => window.SlabInventory ? SlabInventory.gradeLabel(c, { cac: false }) : [c.grade, c.designation].filter(Boolean).join(" ");

  const DEFAULT_TERMS = "This offer is good for today only and is based on the coins listed above. " +
    "By signing, the seller confirms they own these coins and have the right to sell them.";
  let oc = Object.assign({ pct: 85, rules: [], guidePct: null, round: 1, business: "", businessLine: "", terms: DEFAULT_TERMS, showBid: false }, load(OFFERS, {}));
  let store = Object.assign({ deals: [], activeId: "" }, load(DEALS, {}));
  const saveOc = () => save(OFFERS, oc);
  const saveDeals = () => save(DEALS, store);

  // ---------- offer math ----------
  const haystack = c => [c.name, c.series, c.denomination, c.metal].filter(Boolean).join(" ").toLowerCase();
  function ruleFor(c) {
    const h = haystack(c);
    return oc.rules.find(r => r.match && r.pct != null && h.includes(String(r.match).trim().toLowerCase())) || null;
  }
  function roundDown(n) {
    const step = Number(oc.round) || 0;
    if (!step) return Math.round(n * 100) / 100;
    return Math.floor(n / step + 1e-9) * step;
  }
  // { amount, pct, basis: "Greysheet"|"PCGS guide"|"Fixed", why } or null when there is nothing to base it on.
  function offerFor(c) {
    if (!c) return null;
    const fixed = num(c.offerFixed);
    if (fixed != null) return { amount: fixed, basis: "Fixed", why: "set by hand" };
    const grey = num(c.greysheet), guide = num(c.priceGuide);
    const own = num(c.offerPct);
    if (grey != null) {
      const rule = own == null ? ruleFor(c) : null;
      const pct = own != null ? own : rule ? num(rule.pct) : num(oc.pct) ?? 0;
      return { amount: roundDown(grey * pct / 100), pct, basis: "Greysheet",
        why: own != null ? "this coin" : rule ? `“${rule.match}” rule` : "default" };
    }
    if (guide != null && (own != null || num(oc.guidePct) != null)) {
      const pct = own != null ? own : num(oc.guidePct);
      return { amount: roundDown(guide * pct / 100), pct, basis: "PCGS guide", why: own != null ? "this coin" : "no Greysheet bid" };
    }
    return null;
  }
  const offerAmount = c => { const o = offerFor(c); return o ? o.amount : null; };
  const describe = o => !o ? "" : o.basis === "Fixed" ? "fixed price" : `${o.pct}% of ${o.basis}`;

  // ---------- deals ----------
  let api = null; // set by init(): { coins, saveCoins, toast, deliver, showView, renderList }
  const coins = () => (api ? api.coins : []);
  const dealById = id => store.deals.find(d => d.id === id) || null;
  const active = () => dealById(store.activeId);
  const coinsIn = d => coins().filter(c => c.dealId === d.id);
  function totals(list) {
    let grey = 0, offer = 0, paid = 0, priced = 0, unpriced = 0;
    list.forEach(c => {
      grey += num(c.greysheet) || 0; paid += num(c.paid) || 0;
      const a = offerAmount(c); if (a == null) unpriced++; else { offer += a; priced++; }
    });
    return { count: list.length, grey, offer, paid, priced, unpriced };
  }
  const lotTotal = d => { const t = totals(coinsIn(d)); return num(d.lotOffer) != null ? num(d.lotOffer) : t.offer; };
  const sellerName = d => d.seller || "Unnamed seller";

  function setActive(id) { store.activeId = id || ""; saveDeals(); renderBar(); }

  // ---------- scan tab bar ----------
  function renderBar() {
    const el = document.getElementById("deal-bar"); if (!el) return;
    const d = active();
    if (!d) {
      el.className = "deal-bar idle";
      el.innerHTML = `<span>Not adding to a deal.</span><button type="button" data-act="start">Start a deal</button>`;
      return;
    }
    const t = totals(coinsIn(d));
    el.className = "deal-bar on";
    el.innerHTML = `<div><small>Adding to deal</small><b>${esc(sellerName(d))}</b>
      <span>${t.count} coin${t.count === 1 ? "" : "s"} · offer ${money0(lotTotal(d))}</span></div>
      <button type="button" data-act="open">View</button><button type="button" data-act="end">Done</button>`;
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("#deal-bar [data-act]"); if (!b) return;
    if (b.dataset.act === "end") { setActive(""); api && api.toast("Stopped adding to the deal"); }
    else if (b.dataset.act === "open") { view = { mode: "detail", id: store.activeId }; api.showView("deals"); }
    else if (b.dataset.act === "start") { view = { mode: "new" }; api.showView("deals"); }
  });

  // One line under the Greysheet field on the scan result card.
  function offerLine(c) {
    const o = offerFor(c), d = active();
    const parts = [];
    if (o) parts.push(`Offer <b>${money(o.amount)}</b> <span class="muted">(${esc(describe(o))})</span>`);
    else parts.push(`<span class="muted">Enter a Greysheet bid to see your ${num(oc.pct) ?? 0}% offer.</span>`);
    if (d) parts.push(`<span class="muted">Goes into ${esc(sellerName(d))}’s deal.</span>`);
    return parts.join(" ");
  }

  // ---------- deals tab ----------
  let view = { mode: "list" };
  const root = () => document.getElementById("deals-root");
  function render() {
    const el = root(); if (!el) return;
    if (view.mode === "detail" && !dealById(view.id)) view = { mode: "list" };
    if (view.mode === "new") return renderNew(el);
    if (view.mode === "detail") return renderDetail(el, dealById(view.id));
    if (view.mode === "pick") return renderPick(el, dealById(view.id));
    renderDealList(el);
  }
  const statusChip = d => `<span class="deal-chip ${esc((d.status || "open").toLowerCase())}">${esc(d.status || "Open")}</span>`;

  function renderDealList(el) {
    const deals = [...store.deals].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    el.innerHTML = `
      <div class="row"><button type="button" class="primary big" data-act="new">New deal</button></div>
      ${deals.length ? "" : `<p class="muted">A deal groups the coins you're buying from one seller, works out your offer, and prints an offer sheet for them to sign.</p>`}
      <ul class="deal-list">${deals.map(d => {
        const t = totals(coinsIn(d));
        return `<li class="deal" data-id="${esc(d.id)}">
          <div class="meta"><b>${esc(sellerName(d))}</b>
            <span>${esc(fmtDate(d.date))} · ${t.count} coin${t.count === 1 ? "" : "s"}${d.id === store.activeId ? " · <em>adding now</em>" : ""}</span></div>
          <div class="amt"><b>${money0(lotTotal(d))}</b>${statusChip(d)}</div>
        </li>`;
      }).join("")}</ul>`;
  }

  function dealFields(d) {
    return `
      <label>Seller name<input name="seller" value="${esc(d.seller)}" placeholder="e.g. Jane Smith" autocomplete="off"></label>
      <label>Phone or email<input name="contact" value="${esc(d.contact)}" placeholder="Optional" autocomplete="off"></label>
      <div class="grid2">
        <label>Date<input name="date" type="date" value="${esc(d.date || today())}"></label>
        <label>Status<select name="status">${["Open", "Accepted", "Declined"].map(s => `<option${(d.status || "Open") === s ? " selected" : ""}>${s}</option>`).join("")}</select></label>
      </div>
      <label>Notes<input name="notes" value="${esc(d.notes)}" placeholder="Optional, not printed" autocomplete="off"></label>`;
  }

  function renderNew(el) {
    el.innerHTML = `
      <button type="button" class="back" data-act="list">‹ All deals</button>
      <form class="card" id="deal-new" autocomplete="off">
        <h2>New deal</h2>
        ${dealFields({})}
        <div class="row"><button type="submit" class="primary">Create and start scanning</button></div>
      </form>`;
    const f = el.querySelector("#deal-new");
    f.seller.focus();
    f.addEventListener("submit", e => {
      e.preventDefault();
      const fd = new FormData(f);
      const d = { id: newId(), createdAt: new Date().toISOString(), seller: fd.get("seller").trim(), contact: fd.get("contact").trim(),
        date: fd.get("date") || today(), status: fd.get("status") || "Open", notes: fd.get("notes").trim(), lotOffer: null };
      store.deals.push(d); setActive(d.id);
      view = { mode: "detail", id: d.id };
      api.toast("Deal started. New scans go into it.");
      api.showView("scan");
    });
  }

  function renderDetail(el, d) {
    const list = coinsIn(d), t = totals(list), lot = lotTotal(d);
    const pctOfGrey = t.grey && list.every(c => num(c.greysheet) != null) ? Math.round(lot / t.grey * 1000) / 10 : null;
    el.innerHTML = `
      <button type="button" class="back" data-act="list">‹ All deals</button>
      <div class="deal-head">
        <h2>${esc(sellerName(d))}</h2>
        <p class="muted">${esc(fmtDate(d.date))}${d.contact ? " · " + esc(d.contact) : ""} · ${statusChip(d)}</p>
      </div>
      <div class="totals">
        <div><span>${t.count}</span>coins</div>
        <div><span>${money0(t.grey)}</span>Greysheet</div>
        <div><span>${money0(lot)}</span>${num(d.lotOffer) != null ? "Lot offer" : "Offer"}</div>
        <div><span>${pctOfGrey != null ? pctOfGrey + "%" : "–"}</span>of Greysheet</div>
      </div>
      ${t.unpriced ? `<p class="notice">${t.unpriced} coin${t.unpriced === 1 ? " has" : "s have"} no Greysheet bid, so ${t.unpriced === 1 ? "it isn't" : "they aren't"} in the offer yet. Tap the offer to set one.</p>` : ""}
      <div class="row wrap">
        <button type="button" class="primary" data-act="print">Print offer sheet</button>
        <button type="button" data-act="share">Share sheet</button>
      </div>
      <div class="row wrap">
        <button type="button" data-act="scan">${d.id === store.activeId ? "Scan more coins" : "Scan into this deal"}</button>
        <button type="button" data-act="pick">Add from collection</button>
      </div>
      <ul class="coin-list deal-coins">${list.map(c => {
        const o = offerFor(c);
        return `<li class="coin" data-id="${esc(c.id)}">
          <div class="meta"><b>${esc(c.name || "Unknown coin")}</b>
            <span>${esc(c.service || "")} ${esc(gradeText(c))}${c.cac ? " CAC " + esc(c.cac) : ""} · #${esc(c.certNo || c.rawCode || "")}</span>
            <span class="vals">${c.greysheet != null ? "Grey " + money(c.greysheet) : "No Greysheet bid"}${o ? " · " + esc(describe(o)) : ""}</span></div>
          <div class="actions">
            <button type="button" class="offer-btn" data-act="offer">${o ? money(o.amount) : "Set offer"}</button>
            <button type="button" class="unlink" data-act="unlink" aria-label="Remove from deal">✕</button>
          </div></li>`;
      }).join("")}</ul>
      ${list.length ? "" : `<p class="muted">No coins in this deal yet. Scan some, or add coins you already scanned.</p>`}
      <div class="row wrap">
        <button type="button" data-act="lot">${num(d.lotOffer) != null ? "Change lot price" : "Set one price for the lot"}</button>
      </div>
      <form class="card" id="deal-edit" autocomplete="off">
        <h2>Deal details</h2>
        ${dealFields(d)}
        <div class="row"><button type="submit" class="primary">Save details</button></div>
      </form>
      <div class="row"><button type="button" class="danger" data-act="delete">Delete deal</button></div>
      <p class="muted small">To save a PDF on iPhone: tap Print offer sheet, then the Share button in the print preview, then Save to Files.</p>`;

    el.querySelector("#deal-edit").addEventListener("submit", e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const was = d.status;
      Object.assign(d, { seller: fd.get("seller").trim(), contact: fd.get("contact").trim(), date: fd.get("date") || d.date,
        status: fd.get("status"), notes: fd.get("notes").trim() });
      saveDeals();
      if (d.status === "Accepted" && was !== "Accepted") fillPaid(d);
      api.toast("Deal saved"); renderBar(); render();
    });
  }

  // When a deal is accepted, record what was paid on each coin that has no price paid yet.
  function fillPaid(d) {
    const list = coinsIn(d).filter(c => num(c.paid) == null && offerAmount(c) != null);
    if (!list.length) return;
    if (!confirm(`Set "Price paid" to the offer on ${list.length} coin${list.length === 1 ? "" : "s"} in this deal?`)) return;
    const lot = num(d.lotOffer), sum = totals(coinsIn(d)).offer;
    // A lot price is spread across coins in proportion to each coin's offer.
    list.forEach(c => {
      const a = offerAmount(c); c.paid = lot != null && sum ? Math.round(a * lot / sum * 100) / 100 : a;
      // Bought on the deal's date, unless the coin already moved further along.
      if (window.SlabInventory && !c.status) { c.boughtAt = c.boughtAt || d.date || ""; SlabInventory.setStatus(c, "bought"); }
      touch(c);
    });
    api.saveCoins();
  }

  function renderPick(el, d) {
    const list = coins().filter(c => c.dealId !== d.id);
    el.innerHTML = `
      <button type="button" class="back" data-act="detail">‹ Back to deal</button>
      <h2>Add to ${esc(sellerName(d))}’s deal</h2>
      ${list.length ? `<form id="pick-form"><ul class="pick-list">${list.map(c => {
        const other = c.dealId && dealById(c.dealId);
        return `<li><label class="check"><input type="checkbox" name="id" value="${esc(c.id)}">
          <span><b>${esc(c.name || "Unknown coin")}</b><small>${esc(c.service || "")} ${esc(gradeText(c))} · #${esc(c.certNo || c.rawCode || "")}${other ? " · in " + esc(sellerName(other)) + "’s deal" : ""}</small></span></label></li>`;
      }).join("")}</ul>
      <div class="row"><button type="submit" class="primary">Add selected</button></div></form>`
      : `<p class="muted">Every coin in your collection is already in this deal.</p>`}`;
    const f = el.querySelector("#pick-form");
    f && f.addEventListener("submit", e => {
      e.preventDefault();
      const ids = new FormData(f).getAll("id");
      coins().forEach(c => { if (ids.includes(c.id)) { c.dealId = d.id; touch(c); } });
      api.saveCoins(); view = { mode: "detail", id: d.id }; render();
      api.toast(`Added ${ids.length} coin${ids.length === 1 ? "" : "s"}`);
    });
  }

  document.addEventListener("click", e => {
    const b = e.target.closest("#deals-root [data-act]");
    const li = e.target.closest("#deals-root .deal");
    if (!b && li) { view = { mode: "detail", id: li.dataset.id }; return render(); }
    if (!b) return;
    const d = dealById(view.id);
    const coinLi = b.closest(".coin");
    const c = coinLi && coins().find(x => x.id === coinLi.dataset.id);
    switch (b.dataset.act) {
      case "list": view = { mode: "list" }; break;
      case "new": view = { mode: "new" }; break;
      case "detail": view = { mode: "detail", id: view.id }; break;
      case "pick": view = { mode: "pick", id: d.id }; break;
      case "scan": setActive(d.id); api.showView("scan"); return;
      case "print": printSheet(d); return;
      case "share": shareSheet(d); return;
      case "offer": if (c) editCoinOffer(c); break;
      case "unlink": if (c) { c.dealId = ""; touch(c); api.saveCoins(); } break;
      case "lot": editLot(d); break;
      case "delete":
        if (!confirm(`Delete the deal with ${sellerName(d)}? Its coins stay in your collection.`)) return;
        coins().forEach(x => { if (x.dealId === d.id) { x.dealId = ""; touch(x); } });
        store.deals = store.deals.filter(x => x !== d);
        if (store.activeId === d.id) store.activeId = "";
        saveDeals(); api.saveCoins(); renderBar(); view = { mode: "list" }; break;
    }
    render();
  });

  function editCoinOffer(c) {
    const o = offerFor(c);
    const v = prompt(`Offer for ${c.name || "this coin"}.\nType a price (e.g. 450) or a percent of Greysheet (e.g. 80%). Leave empty to use your usual rates.`,
      c.offerFixed != null ? c.offerFixed : c.offerPct != null ? c.offerPct + "%" : "");
    if (v === null) return;
    const s = v.trim();
    if (!s) { c.offerFixed = null; c.offerPct = null; }
    else if (s.endsWith("%")) { const p = num(s); if (p == null) return api.toast("That isn't a percent."); c.offerPct = p; c.offerFixed = null; }
    else { const n = num(s); if (n == null) return api.toast("That isn't a price."); c.offerFixed = n; c.offerPct = null; }
    touch(c); api.saveCoins();
  }
  function editLot(d) {
    const sum = totals(coinsIn(d)).offer;
    const v = prompt(`One price for the whole lot. The coin offers add up to ${money0(sum)}.\nLeave empty to use that total.`, d.lotOffer ?? "");
    if (v === null) return;
    const n = num(v); d.lotOffer = v.trim() ? n : null; saveDeals(); renderBar();
  }

  // ---------- offer sheet ----------
  function sheetBody(d) {
    const list = coinsIn(d), t = totals(list), lot = num(d.lotOffer);
    const showBid = !!oc.showBid;
    return `
      <header class="os-head">
        <div><h1>${esc(oc.business || "Purchase Offer")}</h1>${oc.businessLine ? `<p>${esc(oc.businessLine)}</p>` : ""}</div>
        <div class="os-meta">${oc.business ? "<b>Purchase Offer</b><br>" : ""}${esc(fmtDate(d.date))}</div>
      </header>
      <section class="os-seller"><b>Seller:</b> ${esc(d.seller || "")}${d.contact ? ` &nbsp;·&nbsp; ${esc(d.contact)}` : ""}</section>
      <table class="os-table">
        <thead><tr><th>#</th><th>Coin</th><th>Grade</th><th>Cert #</th>${showBid ? "<th class=n>Greysheet</th>" : ""}<th class=n>Offer</th></tr></thead>
        <tbody>${list.map((c, i) => { const a = offerAmount(c); return `<tr>
          <td>${i + 1}</td><td>${esc(c.name || "Unknown coin")}</td>
          <td>${esc([c.service, gradeText(c)].filter(Boolean).join(" "))}${c.cac ? " CAC" : ""}</td>
          <td>${esc(c.certNo || "")}</td>${showBid ? `<td class=n>${money(c.greysheet)}</td>` : ""}
          <td class=n>${a != null ? money(a) : "—"}</td></tr>`; }).join("")}</tbody>
        <tfoot>
          <tr><td colspan="4">${t.count} coin${t.count === 1 ? "" : "s"}</td>${showBid ? `<td class=n>${money0(t.grey)}</td>` : ""}<td class=n>${money0(t.offer)}</td></tr>
          ${lot != null ? `<tr class="os-lot"><td colspan="${showBid ? 5 : 4}">Offer for the whole lot</td><td class=n>${money0(lot)}</td></tr>` : ""}
        </tfoot>
      </table>
      <p class="os-total">Total offer: <b>${money0(lot != null ? lot : t.offer)}</b></p>
      ${oc.terms ? `<p class="os-terms">${esc(oc.terms)}</p>` : ""}
      <div class="os-sign">
        <div><span></span>Seller signature</div><div><span></span>Date</div>
        <div><span></span>Seller ID / driver's license #</div><div><span></span>Buyer signature</div>
      </div>`;
  }
  const SHEET_CSS = `
    .offer-sheet { color: #111; background: #fff; font: 12pt/1.4 Georgia, "Times New Roman", serif; }
    .offer-sheet h1 { font-size: 20pt; margin: 0; }
    .offer-sheet .os-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
    .offer-sheet .os-head p { margin: 2px 0 0; font-size: 10pt; }
    .offer-sheet .os-meta { text-align: right; font-size: 11pt; }
    .offer-sheet .os-seller { margin-bottom: 12px; }
    .offer-sheet table { width: 100%; border-collapse: collapse; font: 10.5pt/1.3 -apple-system, Helvetica, Arial, sans-serif; }
    .offer-sheet th, .offer-sheet td { border-bottom: 1px solid #bbb; padding: 5px 6px; text-align: left; vertical-align: top; }
    .offer-sheet th { border-bottom: 1.5px solid #111; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .4px; }
    .offer-sheet .n { text-align: right; white-space: nowrap; }
    .offer-sheet tfoot td { font-weight: 700; border-bottom: 0; border-top: 1.5px solid #111; }
    .offer-sheet tr { break-inside: avoid; }
    .offer-sheet .os-total { font-size: 15pt; text-align: right; margin: 14px 0; }
    .offer-sheet .os-terms { font-size: 9.5pt; color: #333; }
    .offer-sheet .os-sign { display: grid; grid-template-columns: 2fr 1fr; gap: 30px 24px; margin-top: 36px; font-size: 9.5pt; break-inside: avoid; }
    .offer-sheet .os-sign span { display: block; border-bottom: 1px solid #111; height: 28px; margin-bottom: 4px; }`;

  function printSheet(d) {
    if (!coinsIn(d).length) return api.toast("Add coins to the deal first.");
    let el = document.getElementById("print-sheet");
    if (!el) { el = document.createElement("div"); el.id = "print-sheet"; document.body.appendChild(el); }
    el.innerHTML = `<style>${SHEET_CSS}</style><div class="offer-sheet">${sheetBody(d)}</div>`;
    const title = document.title;
    document.title = sheetName(d).replace(/\.html$/, "");
    setTimeout(() => { window.print(); document.title = title; }, 50);
  }
  const sheetName = d => `offer-${(d.seller || "seller").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "seller"}-${d.date || today()}.html`;
  function shareSheet(d) {
    if (!coinsIn(d).length) return api.toast("Add coins to the deal first.");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Offer for ${esc(d.seller || "seller")}</title><style>body{margin:0;padding:24px;background:#fff}${SHEET_CSS}
      @page{margin:16mm}@media print{body{padding:0}}</style></head><body><div class="offer-sheet">${sheetBody(d)}</div></body></html>`;
    api.deliver(new Blob([html], { type: "text/html" }), sheetName(d));
  }

  // ---------- settings card ----------
  function renderSettings() {
    const el = document.getElementById("offer-settings"); if (!el) return;
    el.innerHTML = `
      <h2>Offer calculator</h2>
      <p class="muted">Your offer on each coin is a percentage of its Greysheet bid. Category rules override the default for coins whose name, series, denomination or metal contains the word. The first rule that matches wins.</p>
      <label for="oc-pct">Default offer (% of Greysheet bid)</label>
      <input id="oc-pct" type="number" inputmode="decimal" min="0" max="200" step="0.5" value="${esc(oc.pct)}">
      <label>Category rules</label>
      <ul class="rules">${oc.rules.map((r, i) => `<li data-i="${i}">
        <input class="r-match" value="${esc(r.match)}" placeholder="e.g. Morgan, Gold, Proof" autocapitalize="off">
        <input class="r-pct" type="number" inputmode="decimal" min="0" max="200" step="0.5" value="${esc(r.pct ?? "")}" placeholder="%">
        <button type="button" class="r-del" aria-label="Remove rule">✕</button></li>`).join("")}</ul>
      <button type="button" id="oc-add" class="ghost">Add a category rule</button>
      <label for="oc-guide">No Greysheet bid? Offer this % of the PCGS Price Guide</label>
      <input id="oc-guide" type="number" inputmode="decimal" min="0" max="200" step="0.5" value="${esc(oc.guidePct ?? "")}" placeholder="Leave blank to skip those coins">
      <label for="oc-round">Round each offer down to</label>
      <select id="oc-round">${[[0, "the cent"], [1, "$1"], [5, "$5"], [10, "$10"], [25, "$25"]].map(([v, t]) => `<option value="${v}"${Number(oc.round) === v ? " selected" : ""}>${t}</option>`).join("")}</select>
      <h2 class="sub">Offer sheet</h2>
      <label for="oc-biz">Business name</label>
      <input id="oc-biz" value="${esc(oc.business)}" placeholder="Printed at the top">
      <label for="oc-line">Address and phone</label>
      <input id="oc-line" value="${esc(oc.businessLine)}" placeholder="Optional second line">
      <label for="oc-terms">Terms printed above the signatures</label>
      <textarea id="oc-terms" rows="3">${esc(oc.terms)}</textarea>
      <label class="check"><input type="checkbox" id="oc-bid"${oc.showBid ? " checked" : ""}> Show Greysheet bids on the sheet</label>`;
  }
  function readSettings() {
    const el = document.getElementById("offer-settings"); if (!el) return;
    oc.pct = num(el.querySelector("#oc-pct").value) ?? 0;
    oc.rules = [...el.querySelectorAll(".rules li")].map(li => ({ match: li.querySelector(".r-match").value.trim(), pct: num(li.querySelector(".r-pct").value) }));
    oc.guidePct = num(el.querySelector("#oc-guide").value);
    oc.round = Number(el.querySelector("#oc-round").value) || 0;
    oc.business = el.querySelector("#oc-biz").value.trim();
    oc.businessLine = el.querySelector("#oc-line").value.trim();
    oc.terms = el.querySelector("#oc-terms").value.trim();
    oc.showBid = el.querySelector("#oc-bid").checked;
    saveOc(); renderBar();
  }
  document.addEventListener("change", e => { if (e.target.closest("#offer-settings")) readSettings(); });
  document.addEventListener("click", e => {
    if (e.target.closest("#oc-add")) { readSettings(); oc.rules.push({ match: "", pct: oc.pct }); saveOc(); renderSettings();
      const m = document.querySelectorAll("#offer-settings .r-match"); m.length && m[m.length - 1].focus(); }
    const del = e.target.closest("#offer-settings .r-del");
    if (del) { readSettings(); oc.rules.splice(+del.closest("li").dataset.i, 1); saveOc(); renderSettings(); }
  });

  // ---------- wiring ----------
  document.addEventListener("slab:view", e => {
    if (e.detail === "deals") { if (view.mode === "pick") view = { mode: "detail", id: view.id }; render(); }
    if (e.detail === "scan") renderBar();
    if (e.detail === "settings") renderSettings();
  });

  window.SlabDeals = {
    init(a) { api = a; renderBar(); renderSettings(); },
    offerFor, offerAmount, describe, offerLine, totals,
    activeId: () => (active() ? store.activeId : ""),
    dealOf: c => (c && c.dealId ? dealById(c.dealId) : null),
    sellerName,
    refresh() { renderBar(); if (document.getElementById("view-deals")?.classList.contains("active")) render(); },
  };
})();
