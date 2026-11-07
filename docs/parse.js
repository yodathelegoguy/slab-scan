// Turns a raw scanned string into { service, cert, raw, kind }.
// service: "PCGS" | "NGC" | null (unknown)  kind: "cert" | "barcode"
(function (global) {
  function parseScan(raw, preferred) {
    const text = String(raw || "").trim();
    const out = { raw: text, service: null, cert: null, kind: "barcode" };
    if (!text) return out;

    // QR codes on newer holders carry a verification URL.
    const pcgsUrl = text.match(/pcgs\.com\/cert\/(?:[a-z]+\/)?(\d{6,10})/i);
    if (pcgsUrl) return { ...out, service: "PCGS", cert: pcgsUrl[1], kind: "cert" };
    const ngcUrl = text.match(/ngccoin\.com\/certlookup\/(\d{6,10}-\d{3})/i)
      || text.match(/ngccoin\.com\/certlookup\/(\d{6,10})/i);
    if (ngcUrl) return { ...out, service: "NGC", cert: ngcUrl[1], kind: "cert" };
    if (/pcgs\.com/i.test(text)) out.service = "PCGS";
    if (/ngccoin\.com/i.test(text)) out.service = "NGC";

    // NGC cert numbers look like 1234567-001 (number, dash, 3-digit suffix).
    const ngcCert = text.match(/^(\d{6,10})-(\d{3})$/);
    if (ngcCert) return { ...out, service: "NGC", cert: text, kind: "cert" };

    const svc = preferred && preferred !== "auto" ? preferred : out.service;

    // A short all-digit string is a typed or encoded cert number.
    if (/^\d{6,9}$/.test(text)) {
      return { ...out, service: svc || "PCGS", cert: text, kind: "cert" };
    }
    // Longer strings are holder barcodes; the PCGS barcode endpoint decodes
    // both PCGS and NGC barcodes, so pass them through raw.
    return { ...out, service: svc || out.service || (preferred === "auto" ? null : preferred), kind: "barcode" };
  }

  function verifyUrl(service, cert) {
    if (!cert) return null;
    if (service === "PCGS") return `https://www.pcgs.com/cert/${encodeURIComponent(cert)}`;
    if (service === "NGC") return `https://www.ngccoin.com/certlookup/${encodeURIComponent(cert)}/`;
    return null;
  }

  global.parseScan = parseScan;
  global.verifyUrl = verifyUrl;
  if (typeof module !== "undefined") module.exports = { parseScan, verifyUrl };
})(typeof window !== "undefined" ? window : globalThis);
