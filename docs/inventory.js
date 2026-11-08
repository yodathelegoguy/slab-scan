/* Inventory and grade-designation helpers for Slab Scan.
 * Pure functions, no DOM. The coin record they work on is documented in DATA-MODEL.md.
 * Exposed as window.SlabInventory so other modules (export, sync, deals) can share them. */
(() => {
  // Inventory status, in workflow order. "" means scanned only (appraisal, not bought).
  const STATUSES = [
    { value: "", label: "Scanned", short: "Scanned" },
    { value: "bought", label: "In stock", short: "In stock" },
    { value: "listed", label: "Listed for sale", short: "Listed" },
    { value: "sold", label: "Sold", short: "Sold" },
  ];
  const STATUS_DATE = { bought: "boughtAt", listed: "listedAt", sold: "soldAt" };
  const CAC = ["", "Green", "Gold"];

  const n = v => {
    if (v === null || v === undefined || v === "") return null;
    const x = parseFloat(String(v).replace(/[$,\s]/g, ""));
    return isNaN(x) ? null : x;
  };
  const statusLabel = s => (STATUSES.find(x => x.value === (s || "")) || STATUSES[0]).short;

  // Plus (+) and star (★) from PCGS data or a typed grade like "MS65+★" or "PR68*".
  function gradeFlags(coin) {
    const grade = String(coin.grade || ""), des = String(coin.designation || "");
    return {
      plus: coin.plus === true || /\+/.test(grade),
      star: coin.star === true || /[★*]/.test(grade) || /\bstar\b/i.test(des),
    };
  }
  // Grade without plus/star marks, so they can be shown and stored separately.
  const baseGrade = g => String(g || "").replace(/[+★*]/g, "").trim();
  // "MS65+★ CAC Gold" style label for lists and exports.
  function gradeLabel(coin, { cac = true } = {}) {
    const f = gradeFlags(coin);
    const g = baseGrade(coin.grade) + (f.plus ? "+" : "") + (f.star ? "★" : "");
    return [g, coin.designation, cac && coin.cac ? "CAC " + coin.cac : ""].filter(Boolean).join(" ");
  }

  // Profit only exists once a coin is sold with a sale price. Fees are optional.
  function profit(coin) {
    if (coin.status !== "sold") return null;
    const sale = n(coin.salePrice); if (sale === null) return null;
    return Math.round((sale - (n(coin.fees) || 0) - (n(coin.paid) || 0)) * 100) / 100;
  }

  // Fills defaults on records saved by older versions. Safe to run on every load.
  function normalize(coin) {
    const f = gradeFlags(coin);
    coin.plus = f.plus; coin.star = f.star;
    if (!CAC.includes(coin.cac || "")) coin.cac = /gold/i.test(coin.cac) ? "Gold" : coin.cac ? "Green" : "";
    coin.cac = coin.cac || "";
    // Records from before inventory tracking: a price paid means it was bought.
    if (coin.status === undefined && n(coin.paid) !== null) coin.status = "bought";
    if (!STATUSES.some(s => s.value === (coin.status || ""))) coin.status = "";
    coin.status = coin.status || "";
    for (const k of ["listPrice", "salePrice", "fees"]) coin[k] = n(coin[k]);
    for (const k of ["boughtAt", "listedAt", "soldAt", "soldTo"]) coin[k] = coin[k] || "";
    return coin;
  }

  // Changes status and stamps today's date for the new stage if it has none yet.
  // Earlier stages are left alone: an unknown buy date stays blank rather than wrong.
  function setStatus(coin, status, today = new Date().toISOString().slice(0, 10)) {
    coin.status = status || "";
    const k = STATUS_DATE[coin.status];
    if (k && !coin[k]) coin[k] = today;
    return coin;
  }

  // Fields the user owns. A fresh PCGS lookup must never overwrite them.
  const USER_FIELDS = ["id", "addedAt", "updatedAt", "greysheet", "greysheetUrl", "paid", "cac", "plus", "star",
    "notes", "rawCode", "status", "listPrice", "salePrice", "fees", "boughtAt", "listedAt", "soldAt", "soldTo",
    "meltMetal", "meltOz"];

  // Totals for a list of coins (after any filter).
  function totals(coins) {
    const sum = k => coins.reduce((a, c) => a + (n(c[k]) || 0), 0);
    const sold = coins.filter(c => c.status === "sold");
    const owned = coins.filter(c => c.status === "bought" || c.status === "listed");
    return {
      count: coins.length,
      greysheet: sum("greysheet"), priceGuide: sum("priceGuide"), paid: sum("paid"),
      inStockCost: owned.reduce((a, c) => a + (n(c.paid) || 0), 0),
      sales: sold.reduce((a, c) => a + (n(c.salePrice) || 0), 0),
      profit: sold.reduce((a, c) => a + (profit(c) || 0), 0),
      soldCount: sold.length, ownedCount: owned.length,
    };
  }

  window.SlabInventory = { STATUSES, STATUS_DATE, CAC, USER_FIELDS, statusLabel, gradeFlags, baseGrade, gradeLabel, profit, normalize, setStatus, totals };
})();
