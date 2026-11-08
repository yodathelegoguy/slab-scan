/* Slab Scan shared collection: keeps every phone's saved data in step through the
 * lookup server's /sync endpoint (Cloudflare D1).
 *
 * It works on the app's saved data directly, so other features don't need to know
 * about it. Each synced collection is a localStorage key holding either
 *   - an array of records that each have a unique `id` (coins, deals, ...), or
 *   - a plain object map of key -> value (saved Greysheet links, ...).
 * Whole records are sent, so new fields sync with no change here.
 *
 * To sync a new kind of data, add a line to COLLECTIONS below (or call
 * SlabSync.collection({...}) from another script before the page finishes loading),
 * call SlabSync.changed() after saving it, and reload it on the "slabsync:changed" event.
 */
(() => {
  const COLLECTIONS = [
    { kind: "coin", key: "slabscan.coins.v1", type: "array",
      // Newest first, the same order the app adds coins in.
      sort: (a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")) },
    { kind: "gslink", key: "slabscan.greysheet.v1", type: "map" },
  ];
  const STATE = "slabscan.sync.v1";      // settings + cursor
  const SHADOW = "slabscan.syncshadow.v1"; // what each record looked like at the last sync
  const CFG = "slabscan.config.v1";      // the app's own settings (server URL + passcode)
  const PUSH_CHUNK = 200, EVERY_MS = 30000;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  let state = Object.assign({ enabled: true, name: "", cursor: 0, lastSync: 0, lastError: "", total: 0 }, load(STATE, {}));
  let shadow = load(SHADOW, {}); // { kind: { id: { h: hash, u: updatedAt } } }
  const saveState = () => store(STATE, state);

  // Short fingerprint of a record, to notice local edits without touching the app's code.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ":" + str.length.toString(36);
  }
  function server() {
    const cfg = load(CFG, {});
    let proxy = cfg.proxy || "";
    if (!proxy && /\.workers\.dev$/i.test(location.hostname)) proxy = location.origin;
    return { proxy: proxy.replace(/\/+$/, ""), appKey: cfg.appKey || "" };
  }
  function entries(col) {
    const raw = load(col.key, col.type === "array" ? [] : {});
    const out = new Map();
    if (col.type === "array") { if (Array.isArray(raw)) raw.forEach(r => { if (r && r.id != null) out.set(String(r.id), r); }); }
    else if (raw && typeof raw === "object") Object.keys(raw).forEach(k => out.set(k, raw[k]));
    return out;
  }

  // Local changes since the last sync: new or edited records, and deletions.
  function localChanges() {
    const now = Date.now(), changes = [];
    for (const col of COLLECTIONS) {
      const sh = shadow[col.kind] || (shadow[col.kind] = {});
      const cur = entries(col);
      for (const [id, rec] of cur) {
        const h = hash(JSON.stringify(rec));
        if (!sh[id] || sh[id].h !== h) changes.push({ kind: col.kind, id, data: rec, updatedAt: now, h });
      }
      for (const id of Object.keys(sh)) {
        if (!cur.has(id) && !sh[id].d) changes.push({ kind: col.kind, id, deleted: true, updatedAt: now });
      }
    }
    return changes;
  }

  // Apply records from the server. A record edited here since the last sync keeps the
  // local edit (it's newer and goes up on the next push).
  function applyRemote(rows) {
    const byKind = {};
    rows.forEach(r => (byKind[r.kind] = byKind[r.kind] || []).push(r));
    let changed = false;
    for (const col of COLLECTIONS) {
      const list = byKind[col.kind]; if (!list) continue;
      const sh = shadow[col.kind] || (shadow[col.kind] = {});
      const raw = load(col.key, col.type === "array" ? [] : {});
      const arr = col.type === "array" ? (Array.isArray(raw) ? raw : []) : null;
      const map = col.type === "map" ? (raw && typeof raw === "object" ? raw : {}) : null;
      const index = new Map(); if (arr) arr.forEach((r, i) => r && r.id != null && index.set(String(r.id), i));
      let touched = false, added = false;
      for (const r of list) {
        const id = String(r.id), prev = sh[id];
        if (prev && r.updatedAt <= prev.u) continue; // already have this version (or newer)
        const local = arr ? (index.has(id) ? arr[index.get(id)] : undefined) : (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined);
        const dirty = local !== undefined ? (!prev || prev.d || prev.h !== hash(JSON.stringify(local))) : (prev && !prev.d);
        if (dirty && prev) continue; // edited here since the last sync, so the local edit wins
        if (r.deleted) {
          if (local !== undefined) {
            if (arr) arr[index.get(id)] = undefined; else delete map[id];
            touched = true;
          }
          sh[id] = { h: "", u: r.updatedAt, d: 1 };
        } else {
          if (local !== undefined && JSON.stringify(local) === JSON.stringify(r.data)) { sh[id] = { h: hash(JSON.stringify(local)), u: r.updatedAt }; continue; }
          if (arr) {
            if (index.has(id)) arr[index.get(id)] = r.data; else { index.set(id, arr.length); arr.push(r.data); added = true; }
          } else map[id] = r.data;
          sh[id] = { h: hash(JSON.stringify(r.data)), u: r.updatedAt };
          touched = true;
        }
      }
      if (touched) {
        let out = map;
        if (arr) { out = arr.filter(x => x !== undefined); if (added && col.sort) out.sort(col.sort); }
        if (!store(col.key, out)) throw new Error("Phone storage is full, so synced coins could not be saved.");
        changed = true;
      }
    }
    return changed;
  }

  let running = null, again = false, timer = null;
  async function syncNow(opts = {}) {
    if (running) { again = true; return running; }
    running = (async () => {
      const { proxy, appKey } = server();
      if (!state.enabled) return report("off");
      if (!proxy) return report("Add the lookup server in Settings to share the collection.", true);
      if (!navigator.onLine) return report("Offline. Changes will sync when you're back online.", true);
      let anyRemote = false;
      try {
        let pending = localChanges();
        let first = true, more = true, guard = 0;
        while ((first || more || pending.length) && guard++ < 200) {
          const chunk = pending.slice(0, PUSH_CHUNK); pending = pending.slice(PUSH_CHUNK);
          const r = await fetch(proxy + "/sync", {
            method: "POST",
            headers: { "X-App-Key": appKey, "Content-Type": "application/json" },
            redirect: "manual", // with Cloudflare Access on, an expired sign-in shows up as a redirect
            body: JSON.stringify({
              since: state.cursor, by: state.name || "",
              changes: chunk.map(({ h, ...c }) => c),
            }),
          });
          if (r.type === "opaqueredirect") return report("Your Cloudflare sign-in expired. Open the lookup server's address in Safari to sign in again.", true);
          const d = await r.json().catch(() => ({ ok: false, error: `Server returned HTTP ${r.status}` }));
          if (!d.ok) {
            if (d.noDatabase) return report("The server isn't set up for sharing yet (see SETUP.md, Part 4).", true, true);
            return report(d.error || `Sync failed (HTTP ${r.status}).`, true);
          }
          // Record what we just sent as synced, unless it was edited again meanwhile.
          for (const c of chunk) {
            const sh = shadow[c.kind] || (shadow[c.kind] = {});
            sh[c.id] = c.deleted ? { h: "", u: c.updatedAt, d: 1 } : { h: c.h, u: c.updatedAt };
          }
          if (d.reset) { state.cursor = 0; }
          if (applyRemote(d.changes || [])) anyRemote = true;
          state.cursor = d.cursor;
          store(SHADOW, shadow); saveState();
          more = d.more; first = false;
        }
        state.total = entries(COLLECTIONS[0]).size;
        report("", false);
      } catch (e) {
        report(/Failed to fetch|NetworkError|Load failed/i.test(String(e && e.message)) ? "Couldn't reach the server. Will try again." : String(e && e.message || e), true);
      } finally {
        if (anyRemote) window.dispatchEvent(new CustomEvent("slabsync:changed"));
      }
    })();
    try { await running; } finally {
      running = null;
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  }
  let noServerDb = false;
  function report(msg, isError, noDb) {
    noServerDb = Boolean(noDb);
    if (msg === "off") { state.lastError = ""; saveState(); return render(); }
    state.lastError = isError ? msg : "";
    if (!isError) state.lastSync = Date.now();
    saveState(); render();
  }
  // Call after saving anything; syncs a moment later so quick edits go up together.
  function changed() {
    if (!state.enabled) return;
    clearTimeout(timer); timer = setTimeout(syncNow, 1500);
  }

  // ---------- settings card ----------
  const $ = s => document.querySelector(s);
  function render() {
    const st = $("#sync-status"); if (!st) return;
    if (!state.enabled) st.textContent = "Sharing is off. This phone keeps its own collection.";
    else if (state.lastError) st.textContent = state.lastError;
    else if (state.lastSync) st.textContent = `Shared collection: ${state.total} coin${state.total === 1 ? "" : "s"}. Last synced ${new Date(state.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    else st.textContent = "Not synced yet.";
    const badge = $("#sync-dot");
    if (badge) {
      badge.classList.toggle("hidden", !state.enabled || noServerDb);
      badge.classList.toggle("err", Boolean(state.lastError));
      badge.title = st.textContent;
    }
  }
  function bindUi() {
    const name = $("#sync-name"), on = $("#sync-on"), now = $("#sync-now");
    if (name) {
      name.value = state.name || "";
      name.addEventListener("change", () => { state.name = name.value.trim().slice(0, 40); saveState(); });
    }
    if (on) {
      on.checked = state.enabled;
      on.addEventListener("change", () => { state.enabled = on.checked; saveState(); render(); if (state.enabled) syncNow(); });
    }
    if (now) now.addEventListener("click", () => { state.enabled = true; if (on) on.checked = true; saveState(); syncNow(); });
    render();
  }

  function start() {
    bindUi();
    syncNow();
    setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, EVERY_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow(); });
    window.addEventListener("online", () => syncNow());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else setTimeout(start, 0);

  window.SlabSync = {
    changed, syncNow,
    userName: () => state.name || "",
    collection(def) { if (def && def.kind && def.key && !COLLECTIONS.some(c => c.kind === def.kind)) COLLECTIONS.push({ type: "array", ...def }); },
    get enabled() { return state.enabled; },
  };
})();
