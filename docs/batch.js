/* Batch mode: keep the camera open and scan a whole box of slabs.
   Each new slab beeps once and is saved straight to the collection without a
   PCGS lookup (coins looked up before reuse their saved details). A slab that is
   already in the collection gets a low double beep and is skipped. Details are
   filled in later with "Fill in missing details" on the Collection tab. */
(() => {
  const $ = s => document.querySelector(s);
  const app = () => window.SlabApp;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let active = false;
  let session = []; // this batch, newest first: { id, label, status: "added"|"dup"|"removed", coinId, name }

  // ---------- feedback: sound, vibration, flash ----------
  let audio = null, hapticLabel = null;
  function unlock() {
    // Must run inside a tap: iOS only lets sound play from an AudioContext created or resumed by a gesture.
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      const b = audio.createBuffer(1, 1, 22050), src = audio.createBufferSource();
      src.buffer = b; src.connect(audio.destination); src.start(0);
    } catch {}
    if (!hapticLabel) {
      // iOS Safari has no vibrate(); toggling a hidden switch control gives a light haptic tick on iOS 18+.
      hapticLabel = document.createElement("label");
      hapticLabel.className = "haptic"; hapticLabel.setAttribute("aria-hidden", "true");
      hapticLabel.innerHTML = '<input type="checkbox" switch tabindex="-1">';
      document.body.appendChild(hapticLabel);
    }
  }
  function tone(freq, at, dur) {
    const t = audio.currentTime + at, o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function signal(kind) {
    try {
      if (audio) {
        if (audio.state === "suspended") audio.resume();
        if (kind === "ok") tone(1500, 0, 0.09);
        else { tone(420, 0, 0.13); tone(420, 0.18, 0.13); }
      }
    } catch {}
    try { navigator.vibrate && navigator.vibrate(kind === "ok" ? 50 : [80, 60, 80]); } catch {}
    try { if (hapticLabel) { hapticLabel.click(); if (kind !== "ok") setTimeout(() => hapticLabel.click(), 160); } } catch {}
    const w = $("#reader-wrap");
    w.classList.remove("flash-ok", "flash-dup"); void w.offsetWidth;
    w.classList.add(kind === "ok" ? "flash-ok" : "flash-dup");
  }

  // ---------- scanning ----------
  function parse(text) {
    const cfg = app().cfg;
    const p = parseScan(text, cfg.service);
    if (!p.service && cfg.service === "auto") p.service = "PCGS";
    return p;
  }
  // Same physical code, or the same cert number at the same grading service.
  const findDup = p => app().coins.find(c =>
    (p.raw && c.rawCode === p.raw) || (p.cert && c.certNo === p.cert && c.service === p.service));

  function makeEntry(p) {
    const mem = app().fromMemory(p) || {};
    return {
      ...mem,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      addedAt: new Date().toISOString(),
      service: mem.service || p.service, certNo: mem.certNo || p.cert || "", rawCode: p.raw,
      name: mem.name || "", grade: mem.grade || "",
      greysheet: null, greysheetUrl: "", paid: null, cac: "", notes: "",
    };
  }
  const labelFor = p => `${p.service || ""} #${p.cert || p.raw}`.trim();

  function onCode(text) {
    const p = parse(text);
    const dup = findDup(p);
    if (dup) {
      signal("dup");
      session.unshift({ id: rid(), label: labelFor(p), status: "dup", raw: text, name: dup.name });
    } else {
      const entry = makeEntry(p);
      app().addCoin(entry); signal("ok");
      session.unshift({ id: rid(), label: labelFor(p), status: "added", coinId: entry.id, name: entry.name });
    }
    render();
  }
  const rid = () => Math.random().toString(36).slice(2, 9);

  async function start() {
    unlock();
    await app().stopScan();
    active = true;
    $("#result").classList.add("hidden");
    $("#batch-panel").classList.remove("hidden");
    render();
    await app().startScan({ onCode, onStop });
  }
  function onStop() { active = false; render(); }

  // ---------- panel ----------
  const added = () => session.filter(s => s.status === "added").length;
  const dups = () => session.filter(s => s.status === "dup").length;
  function render() {
    const n = added(), d = dups();
    $("#batch-count").textContent = n;
    $("#batch-count").classList.toggle("hidden", !active);
    $("#batch-n").textContent = n;
    $("#batch-dups").textContent = d ? ` · ${d} duplicate${d === 1 ? "" : "s"} skipped` : "";
    $("#batch-title").textContent = active ? "Batch scanning" : "Batch finished";
    $("#batch-finish").classList.toggle("hidden", !active);
    $("#batch-more").classList.toggle("hidden", active);
    $("#batch-view").classList.toggle("hidden", active || !n);
    $("#batch-hint").textContent = active
      ? "Hold each slab in the box until it beeps, then move to the next. A low double beep means it's already in your collection."
      : n ? "No PCGS lookups were used. Tap Fill in missing details on the Collection tab when you have lookups to spare." : "Nothing was added.";
    if (active) app().status(n || d ? `${n} added. Next slab…` : "Looking for the first slab…");
    $("#batch-list").innerHTML = session.map(s => `
      <li class="b-${s.status}" data-id="${s.id}">
        <span class="b-icon">${s.status === "added" ? "✓" : s.status === "dup" ? "!" : "–"}</span>
        <span class="b-text"><b>${esc(s.label)}</b>
          <small>${s.status === "added" ? (s.name ? esc(s.name) : "Added, details later")
            : s.status === "dup" ? "Already in collection, skipped" + (s.name ? ": " + esc(s.name) : "")
            : "Removed"}</small></span>
        ${s.status === "added" ? `<button type="button" class="b-undo" aria-label="Remove">Undo</button>`
          : s.status === "dup" ? `<button type="button" class="b-again">Add anyway</button>` : ""}
      </li>`).join("");
  }

  $("#start-batch").addEventListener("click", () => { session = []; start(); });
  $("#batch-more").addEventListener("click", start);
  $("#batch-finish").addEventListener("click", () => app().stopScan());
  $("#batch-view").addEventListener("click", () => { $("#batch-panel").classList.add("hidden"); app().showView("list"); });
  $("#batch-close").addEventListener("click", () => { app().stopScan(); $("#batch-panel").classList.add("hidden"); });
  $("#batch-list").addEventListener("click", e => {
    const li = e.target.closest("li"); if (!li) return;
    const s = session.find(x => x.id === li.dataset.id); if (!s) return;
    if (e.target.closest(".b-undo")) {
      app().removeCoin(s.coinId); s.status = "removed";
    } else if (e.target.closest(".b-again")) {
      const entry = makeEntry(parse(s.raw));
      app().addCoin(entry); s.status = "added"; s.coinId = entry.id;
    } else return;
    render();
  });
})();
