"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    engine: $("engine"),
    camera: $("camera"),
    formats: $("formats"),
    crop: $("crop"),
    start: $("start"),
    stop: $("stop"),
    refresh: $("refresh"),
    imageInput: $("imageInput"),
    video: $("video"),
    managed: $("managed"),
    placeholder: $("placeholder"),
    status: $("status"),
    enginePill: $("enginePill"),
    cameraPill: $("cameraPill"),
    formatPill: $("formatPill"),
    resultText: $("resultText"),
    resultFormat: $("resultFormat"),
    resultSource: $("resultSource"),
    log: $("log"),
    workCanvas: $("workCanvas")
  };

  const state = { devices: [], stream: null, scanner: null, engine: "", running: false, timer: 0, detectorCache: new Map() };
  const PRESETS = {
    retail: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    all1d: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "codabar", "itf", "databar", "databar_expanded", "databar_limited"],
    all: []
  };

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    els.log.value = els.log.value ? `${els.log.value}\n${line}` : line;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setStatus(text) { els.status.textContent = text; }
  function setResult(text, format, source) {
    els.resultText.textContent = text || "-";
    els.resultFormat.textContent = format || "-";
    els.resultSource.textContent = source || "-";
  }
  function updatePills() {
    els.enginePill.textContent = `Engine: ${els.engine.value}`;
    els.cameraPill.textContent = `Camera: ${els.camera.selectedOptions[0]?.textContent || "-"}`;
    els.formatPill.textContent = `Formats: ${els.formats.value}`;
  }

  function setManagedPreview(on) {
    els.video.hidden = on;
    els.managed.hidden = !on;
  }

  function chooseDefaultCamera(devices) {
    const rear = devices.find((d) => /back|rear|environment|wide|ultra|tele/i.test(d.label || ""));
    return rear?.deviceId || devices[devices.length - 1]?.deviceId || devices[0]?.deviceId || "";
  }

  async function refreshCameras(preferred) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.devices = devices.filter((d) => d.kind === "videoinput");
    els.camera.innerHTML = "";
    const selected = preferred && state.devices.some((d) => d.deviceId === preferred) ? preferred : chooseDefaultCamera(state.devices);
    state.devices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      option.selected = option.value === selected;
      els.camera.appendChild(option);
    });
    els.camera.disabled = state.devices.length === 0;
    updatePills();
    log(`Cameras: ${state.devices.length}`);
  }

  function stopTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
  }

  async function stopAll() {
    stopTimer();
    state.running = false;
    if (state.engine === "zxing") {
      try { state.scanner?.controls?.stop?.(); } catch {}
      try { state.scanner?.reader?.reset?.(); } catch {}
    } else if (state.engine === "html5qrcode") {
      try { await state.scanner?.stop?.(); } catch {}
      try { state.scanner?.clear?.(); } catch {}
    } else if (state.engine === "quagga") {
      try { window.Quagga?.offDetected?.(state.scanner); } catch {}
      try { window.Quagga?.stop?.(); } catch {}
    }
    if (state.stream?.getTracks) {
      state.stream.getTracks().forEach((track) => { try { track.stop(); } catch {} });
    }
    state.stream = null;
    state.scanner = null;
    state.engine = "";
    els.video.srcObject = null;
    els.managed.innerHTML = "";
    els.placeholder.hidden = false;
    els.start.disabled = false;
    els.stop.disabled = true;
    setManagedPreview(false);
    setStatus("Idle");
  }

  function videoConstraints(deviceId) {
    return {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }
    };
  }

  async function startNativeVideo(deviceId) {
    setManagedPreview(false);
    const stream = await navigator.mediaDevices.getUserMedia(videoConstraints(deviceId));
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play();
    els.placeholder.hidden = true;
  }

  async function getDetector(engine) {
    const key = `${engine}:${els.formats.value}`;
    if (state.detectorCache.has(key)) return state.detectorCache.get(key);
    const DetectorClass = engine === "native" ? window.BarcodeDetector : window.BarcodeDetectionAPI?.BarcodeDetector;
    if (!DetectorClass) return null;
    const wanted = PRESETS[els.formats.value] || PRESETS.retail;
    const supported = typeof DetectorClass.getSupportedFormats === "function" ? await DetectorClass.getSupportedFormats() : [];
    const formats = wanted.length && supported.length ? wanted.filter((f) => supported.includes(f)) : wanted;
    const detector = formats.length ? new DetectorClass({ formats }) : new DetectorClass();
    state.detectorCache.set(key, detector);
    return detector;
  }

  function drawCrop(mode) {
    const canvas = els.workCanvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    const vw = els.video.videoWidth || 1280;
    const vh = els.video.videoHeight || 960;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (mode === "wide") {
      sw = Math.floor(vw * 0.94);
      sh = Math.floor(vh * 0.38);
      sx = Math.floor((vw - sw) / 2);
      sy = Math.floor((vh - sh) / 2);
    } else if (mode === "square") {
      sw = sh = Math.min(vw, vh);
      sx = Math.floor((vw - sw) / 2);
      sy = Math.floor((vh - sh) / 2);
    }
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(els.video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  function cropModes() {
    if (els.crop.value !== "auto") return [els.crop.value];
    return ["full", "wide", "square"];
  }

  function normalize(result) {
    if (!result) return null;
    if (result.getText) return { text: result.getText(), format: String(result.getBarcodeFormat?.() || "zxing") };
    return { text: result.rawValue || result.rawValueString || result.codeResult?.code || result.value || "", format: result.format || result.formatName || result.codeResult?.format || "-" };
  }

  function handleResult(result, source) {
    const out = normalize(result);
    if (!out?.text) return;
    setResult(out.text, out.format, source);
    setStatus("Decoded");
    log(`${source}: ${out.text} [${out.format}]`);
  }

  async function detectorLoop(engine) {
    if (!state.running) return;
    try {
      const detector = await getDetector(engine);
      if (!detector) throw new Error(`${engine} detector unavailable`);
      const modes = cropModes();
      for (const mode of modes) {
        const source = mode === "full" ? els.video : drawCrop(mode);
        const results = await detector.detect(source);
        if (results?.length) {
          handleResult(results[0], `${engine}:${mode}`);
          break;
        }
      }
    } catch (error) {
      log(`${engine} error: ${error.message || error}`);
    } finally {
      if (state.running) state.timer = setTimeout(() => detectorLoop(engine), 800);
    }
  }

  function zxingHints() {
    const ZXing = window.ZXing || window.ZXingBrowser?.ZXing;
    if (!ZXing?.Map || !ZXing?.DecodeHintType || !ZXing?.BarcodeFormat) return undefined;
    const map = { ean_13: ZXing.BarcodeFormat.EAN_13, ean_8: ZXing.BarcodeFormat.EAN_8, upc_a: ZXing.BarcodeFormat.UPC_A, upc_e: ZXing.BarcodeFormat.UPC_E, code_128: ZXing.BarcodeFormat.CODE_128, code_39: ZXing.BarcodeFormat.CODE_39, codabar: ZXing.BarcodeFormat.CODABAR, itf: ZXing.BarcodeFormat.ITF };
    const hints = new ZXing.Map();
    const formats = (PRESETS[els.formats.value] || PRESETS.retail).map((f) => map[f]).filter(Boolean);
    if (formats.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return hints;
  }

  async function startZxing(deviceId) {
    setManagedPreview(false);
    els.placeholder.hidden = true;
    const reader = new window.ZXingBrowser.BrowserMultiFormatReader(zxingHints(), 10);
    const controls = await reader.decodeFromVideoDevice(deviceId || undefined, els.video, (result, error) => {
      if (result) handleResult(result, "zxing:live");
      else if (error?.name && error.name !== "NotFoundException") log(`zxing: ${error.message || error.name}`);
    });
    state.scanner = { reader, controls };
  }

  async function startHtml5(deviceId) {
    setManagedPreview(true);
    els.placeholder.hidden = true;
    els.managed.innerHTML = '<div id="html5region" style="width:100%;height:100%"></div>';
    const reader = new window.Html5Qrcode("html5region");
    const formatMap = window.Html5QrcodeSupportedFormats || {};
    const liveFormats = (PRESETS[els.formats.value] || PRESETS.retail).map((f) => ({
      ean_13: formatMap.EAN_13, ean_8: formatMap.EAN_8, upc_a: formatMap.UPC_A, upc_e: formatMap.UPC_E, code_128: formatMap.CODE_128, code_39: formatMap.CODE_39, codabar: formatMap.CODABAR, itf: formatMap.ITF, databar: formatMap.RSS_14, databar_expanded: formatMap.RSS_EXPANDED
    }[f])).filter((v) => v !== undefined);
    const config = {
      fps: 10,
      aspectRatio: 1.333,
      qrbox: (vw, vh) => ({ width: Math.floor(vw * 0.8), height: Math.floor(vh * 0.28) })
    };
    if (liveFormats.length) config.formatsToSupport = liveFormats;
    await reader.start(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }, config, (text, result) => handleResult(result || text, "html5qrcode:live"), () => {});
    state.scanner = reader;
  }

  async function startQuagga(deviceId) {
    setManagedPreview(true);
    els.placeholder.hidden = true;
    els.managed.innerHTML = "";
    await new Promise((resolve, reject) => {
      window.Quagga.init({
        inputStream: { type: "LiveStream", target: els.managed, constraints: deviceId ? { deviceId, facingMode: "environment" } : { facingMode: "environment" } },
        decoder: { readers: ["ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader", "code_128_reader", "code_39_reader", "codabar_reader", "i2of5_reader"] },
        locate: true, numOfWorkers: 0, frequency: 10
      }, (error) => error ? reject(error) : resolve());
    });
    const onDetected = (result) => handleResult(result, "quagga:live");
    window.Quagga.onDetected(onDetected);
    window.Quagga.start();
    state.scanner = onDetected;
  }

  async function startSelected() {
    if (!window.isSecureContext) throw new Error("HTTPS or localhost required");
    await stopAll();
    updatePills();
    state.engine = els.engine.value;
    state.running = true;
    els.start.disabled = true;
    els.stop.disabled = false;
    log(`Starting ${state.engine}`);
    setStatus(`Starting ${state.engine}`);
    const deviceId = els.camera.value;
    if (state.engine === "native" || state.engine === "ponyfill") {
      await startNativeVideo(deviceId);
      setStatus(`Running ${state.engine}`);
      detectorLoop(state.engine);
    } else if (state.engine === "zxing") {
      await startZxing(deviceId);
      setStatus("Running zxing");
    } else if (state.engine === "html5qrcode") {
      await startHtml5(deviceId);
      setStatus("Running html5-qrcode");
    } else if (state.engine === "quagga") {
      await startQuagga(deviceId);
      setStatus("Running quagga");
    }
  }

  async function testImage(file) {
    if (!file) return;
    log(`Image test with ${els.engine.value}: ${file.name}`);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (els.engine.value === "native" || els.engine.value === "ponyfill") {
        const detector = await getDetector(els.engine.value);
        const results = await detector.detect(img);
        if (results?.length) handleResult(results[0], `${els.engine.value}:image`);
        else log("No image result");
      } else if (els.engine.value === "zxing") {
        const reader = new window.ZXingBrowser.BrowserMultiFormatReader(zxingHints());
        const result = await reader.decodeFromImageElement(img);
        handleResult(result, "zxing:image");
        try { reader.reset(); } catch {}
      } else {
        log("Image test is wired for native, ponyfill, and zxing first.");
      }
    } catch (error) {
      log(`Image test failed: ${error.message || error}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  els.start.addEventListener("click", () => startSelected().catch((error) => { log(`Start failed: ${error.message || error}`); setStatus("Start failed"); els.start.disabled = false; els.stop.disabled = true; }));
  els.stop.addEventListener("click", () => stopAll().catch(() => {}));
  els.refresh.addEventListener("click", () => refreshCameras(els.camera.value).catch((error) => log(`Refresh failed: ${error.message || error}`)));
  els.imageInput.addEventListener("change", () => testImage(els.imageInput.files?.[0]).catch((error) => log(`Image failed: ${error.message || error}`)));
  els.engine.addEventListener("change", updatePills);
  els.camera.addEventListener("change", updatePills);
  els.formats.addEventListener("change", () => { state.detectorCache.clear(); updatePills(); });
  window.addEventListener("beforeunload", () => stopAll().catch(() => {}));

  (async function boot() {
    updatePills();
    log(`UA: ${navigator.userAgent}`);
    log(`Native BarcodeDetector: ${Boolean(window.BarcodeDetector)}`);
    log(`Ponyfill BarcodeDetector: ${Boolean(window.BarcodeDetectionAPI?.BarcodeDetector)}`);
    log(`ZXing Browser: ${Boolean(window.ZXingBrowser)}`);
    log(`html5-qrcode: ${Boolean(window.Html5Qrcode)}`);
    log(`Quagga2: ${Boolean(window.Quagga)}`);
    try {
      await refreshCameras("");
      setStatus("Ready");
    } catch (error) {
      log(`Init failed: ${error.message || error}`);
      setStatus("Init failed");
    }
  }());
}());
