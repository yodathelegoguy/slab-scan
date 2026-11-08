/* Slab barcode scanner: live camera + photo fallback, decoded with zxing-cpp (WebAssembly). */
(function (global) {
  const FORMATS = ["Code128", "Code39", "Code93", "ITF", "QRCode", "DataMatrix", "PDF417", "MicroQRCode"];
  const OPTS = {
    formats: FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
    maxNumberOfSymbols: 1,
  };
  let ready = null;
  function init() {
    if (ready) return ready;
    const Z = global.ZXingWASM;
    if (!Z) return Promise.reject(new Error("Decoder failed to load"));
    ready = Promise.resolve(Z.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => p.endsWith(".wasm") ? new URL("vendor/" + p, document.baseURI).href : prefix + p },
      fireImmediately: true,
    }));
    ready.catch(() => { ready = null; });
    return ready;
  }

  async function decode(imageData, extra) {
    await init();
    const res = await global.ZXingWASM.readBarcodes(imageData, extra ? { ...OPTS, ...extra } : OPTS);
    const hit = res.find(r => r.isValid && r.text);
    return hit ? hit.text : null;
  }

  const LIVE_STEPS = [
    {}, { angle: 8 }, { angle: -8 }, { opts: { binarizer: "FixedThreshold" } },
    {}, { angle: 15 }, { angle: -15 }, { full: true },
  ];
  // Draws a region of the source into the canvas, rotated about its centre.
  function drawRotated(ctx, src, sx, sy, sw, sh, cw, ch, deg) {
    ctx.save();
    if (deg) {
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
      ctx.translate(cw / 2, ch / 2); ctx.rotate(deg * Math.PI / 180); ctx.translate(-cw / 2, -ch / 2);
    }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
    ctx.restore();
  }

  // ---------- live camera ----------
  class LiveScanner {
    constructor({ video, onResult, onStatus }) {
      this.video = video; this.onResult = onResult; this.onStatus = onStatus || (() => {});
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.stream = null; this.track = null; this.running = false; this.frame = 0;
    }

    async pickBackCamera() {
      // iPhone Pro models can't focus close with the plain wide camera; the virtual
      // "Dual Wide"/"Triple" camera switches to macro automatically.
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
        const pref = [/triple/i, /dual wide/i, /dual/i, /back|rear|environment/i];
        for (const re of pref) { const d = devs.find(x => re.test(x.label)); if (d) return d.deviceId; }
      } catch {}
      return null;
    }

    async start() {
      await init().catch(() => {});
      const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: "environment" } }, audio: false });
      // Labels are only visible after permission; switch to the macro-capable camera if there is one.
      const id = await this.pickBackCamera();
      const cur = this.stream.getVideoTracks()[0];
      if (id && cur.getSettings().deviceId !== id) {
        try {
          const s2 = await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: id } }, audio: false });
          this.stream.getTracks().forEach(t => t.stop()); this.stream = s2;
        } catch {}
      }
      this.track = this.stream.getVideoTracks()[0];
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      const adv = [];
      if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({ focusMode: "continuous" });
      if (adv.length) { try { await this.track.applyConstraints({ advanced: adv }); } catch {} }
      this.caps = caps;

      this.video.srcObject = this.stream;
      this.video.setAttribute("playsinline", ""); this.video.muted = true;
      await this.video.play();
      this.running = true;
      this.onStatus("Looking for a barcode…");
      this.loop();
      return caps;
    }

    async setZoom(z) { try { await this.track.applyConstraints({ advanced: [{ zoom: z }] }); } catch {} }
    async setTorch(on) { try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; } }

    async loop() {
      while (this.running) {
        const t0 = performance.now();
        const v = this.video;
        if (v.readyState >= 2 && v.videoWidth) {
          this.frame++;
          const W = v.videoWidth, H = v.videoHeight;
          // Alternate between the guide box (full detail) and the whole frame (downscaled).
          // Cycle through: guide box straight, tilted both ways (slab barcodes are short,
          // so a few degrees of tilt defeats a straight scan), a sharper binarizer, and the whole frame.
          const step = LIVE_STEPS[this.frame % LIVE_STEPS.length];
          let sx, sy, sw, sh, scale;
          if (step.full) { sx = 0; sy = 0; sw = W; sh = H; scale = Math.min(1, 1280 / W); }
          else { sw = W * 0.9; sh = H * 0.5; sx = (W - sw) / 2; sy = (H - sh) / 2; scale = Math.min(1, 1600 / sw); }
          const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
          if (this.canvas.width !== cw) this.canvas.width = cw;
          if (this.canvas.height !== ch) this.canvas.height = ch;
          drawRotated(this.ctx, v, sx, sy, sw, sh, cw, ch, step.angle || 0);
          try {
            const text = await decode(this.ctx.getImageData(0, 0, cw, ch), step.opts);
            if (text && this.running) { this.stop(); this.onResult(text); return; }
          } catch (e) { this.onStatus("Decoder error: " + e.message); }
        }
        const wait = Math.max(0, 90 - (performance.now() - t0));
        await new Promise(r => setTimeout(r, wait));
      }
    }

    stop() {
      this.running = false;
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null; this.track = null;
      this.video.srcObject = null;
    }
  }

  // ---------- still photo ----------
  async function decodeFile(file) {
    const bmp = await loadImage(file);
    const tries = [
      { max: 2600 }, { max: 2600, opts: { binarizer: "FixedThreshold" } },
      { max: 1800, angle: 8 }, { max: 1800, angle: -8 }, { max: 1800, angle: 15 }, { max: 1800, angle: -15 },
      { max: 1800, angle: 22 }, { max: 1800, angle: -22 }, { max: 1200 },
    ];
    const c = document.createElement("canvas"); const ctx = c.getContext("2d", { willReadFrequently: true });
    for (const t of tries) {
      const s = Math.min(1, t.max / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      drawRotated(ctx, bmp, 0, 0, bmp.width, bmp.height, c.width, c.height, t.angle || 0);
      const text = await decode(ctx.getImageData(0, 0, c.width, c.height), t.opts);
      if (text) return text;
    }
    return null;
  }
  function loadImage(file) {
    if (global.createImageBitmap) return createImageBitmap(file).catch(() => viaImg(file));
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error("Could not open photo"));
      img.src = URL.createObjectURL(file);
    });
  }

  global.SlabScanner = { LiveScanner, decodeFile, decode, init };
})(window);
