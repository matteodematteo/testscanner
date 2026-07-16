// app.js — Barcode/QR Scanner logic (html5-qrcode)
(function () {
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");

  const statLatency = document.getElementById("statLatency");
  const statCount = document.getElementById("statCount");
  const statRate = document.getElementById("statRate");

  const fpsInput = document.getElementById("fps");
  const fpsVal = document.getElementById("fpsVal");
  const roiWidthInput = document.getElementById("roiWidth");
  const roiWidthVal = document.getElementById("roiWidthVal");
  const roiHeightInput = document.getElementById("roiHeight");
  const roiHeightVal = document.getElementById("roiHeightVal");
  const zoomInput = document.getElementById("zoom");
  const zoomVal = document.getElementById("zoomVal");
  const focusModeSelect = document.getElementById("focusMode");
  const cameraSelect = document.getElementById("cameraSelect");
  const resolutionSelect = document.getElementById("resolution");
  const actualResEl = document.getElementById("actualRes");
  const applyBtn = document.getElementById("applyBtn");
  const toggleScanBtn = document.getElementById("toggleScanBtn");
  const formatChipsEl = document.getElementById("formatChips");
  const stopOnCaptureEl = document.getElementById("stopOnCapture");
  const beepOnCaptureEl = document.getElementById("beepOnCapture");
  const verifyReadsEl = document.getElementById("verifyReads");
  const capturedListEl = document.getElementById("captured-list");
  const clearListBtn = document.getElementById("clearListBtn");

  // Format definitions matching html5-qrcode supported formats
  const AVAILABLE_FORMATS = [
    { name: "QR_CODE", id: Html5QrcodeSupportedFormats.QR_CODE, label: "QR" },
    { name: "EAN_13", id: Html5QrcodeSupportedFormats.EAN_13, label: "EAN-13" },
    { name: "EAN_8", id: Html5QrcodeSupportedFormats.EAN_8, label: "EAN-8" },
    { name: "CODE_128", id: Html5QrcodeSupportedFormats.CODE_128, label: "Code128" },
    { name: "UPC_A", id: Html5QrcodeSupportedFormats.UPC_A, label: "UPC-A" },
    { name: "UPC_E", id: Html5QrcodeSupportedFormats.UPC_E, label: "UPC-E" },
    { name: "CODE_39", id: Html5QrcodeSupportedFormats.CODE_39, label: "Code39" },
  ];

  // Default configuration
  let config = {
    formats: [
      Html5QrcodeSupportedFormats.QR_CODE,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_39
    ],
    cameraId: "",
    fps: 20,
    roiWidth: 250,
    roiHeight: 250,
    zoom: 1.0,
    focusMode: "continuous",
    resolution: "1080p",
    stopOnCapture: true,
    beepOnCapture: true,
    verifyReads: true
  };

  let html5QrCode = null;
  let isScanning = false;
  let startInProgress = false;
  let activeTrack = null;

  // Gate 2: Double-Read Verification Variables
  let lastScannedRaw = "";
  let lastScannedTime = 0;

  // Gate 3: Cooldown / Deduplication
  const CONSECUTIVE_READ_COOLDOWN = 1500; // ms to accept SAME barcode again
  let lastAcceptedCode = "";
  let lastAcceptedTime = 0;

  // Performance Metrics
  let scanTimestamps = [];
  let totalCapturedCount = 0;
  let scanCountForRate = 0;
  let scanStartTime = 0;

  // Audio Context (Synthesized Web Audio API Beep)
  let audioCtx = null;

  // Capture Database
  let capturedList = [];

  // Tab switching setup
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  function log(msg, type = "info") {
    const timeStr = new Date().toLocaleTimeString([], { hour12: false });
    let prefix = `[${timeStr}] `;
    if (type === "success") prefix += "🟢 ";
    else if (type === "warn") prefix += "⚠️ ";
    else if (type === "error") prefix += "❌ ";
    else prefix += "ℹ️ ";

    logEl.textContent = prefix + msg + "\n" + logEl.textContent;
    console.log(prefix + msg);
  }

  function loadSettings() {
    try {
      const saved = localStorage.getItem("scanner_config");
      if (saved) {
        const parsed = JSON.parse(saved);
        config = { ...config, ...parsed };
      }
    } catch (e) {
      console.error("Failed to load settings from localStorage", e);
    }

    // Render format chips
    formatChipsEl.innerHTML = "";
    AVAILABLE_FORMATS.forEach(fmt => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = fmt.label;
      if (config.formats.includes(fmt.id)) {
        chip.classList.add("active");
      }
      chip.addEventListener("click", () => {
        if (chip.classList.contains("active")) {
          if (config.formats.length <= 1) {
            log("Must keep at least one format active", "warn");
            return;
          }
          chip.classList.remove("active");
          config.formats = config.formats.filter(id => id !== fmt.id);
        } else {
          chip.classList.add("active");
          config.formats.push(fmt.id);
        }
      });
      formatChipsEl.appendChild(chip);
    });

    // Sync input components
    fpsInput.value = config.fps;
    fpsVal.textContent = config.fps;
    roiWidthInput.value = config.roiWidth;
    roiWidthVal.textContent = config.roiWidth;
    roiHeightInput.value = config.roiHeight;
    roiHeightVal.textContent = config.roiHeight;
    zoomInput.value = config.zoom;
    zoomVal.textContent = config.zoom.toFixed(1);
    focusModeSelect.value = config.focusMode;
    resolutionSelect.value = config.resolution;
    stopOnCaptureEl.checked = config.stopOnCapture;
    beepOnCaptureEl.checked = config.beepOnCapture;
    verifyReadsEl.checked = config.verifyReads;

    // Retrieve previous captures
    try {
      const savedList = localStorage.getItem("scanner_captured");
      if (savedList) {
        capturedList = JSON.parse(savedList);
        totalCapturedCount = capturedList.length;
        updateCapturedUI();
      }
    } catch (e) {
      console.error("Failed to load captures", e);
    }
  }

  function saveSettings() {
    config.fps = parseInt(fpsInput.value, 10);
    config.roiWidth = parseInt(roiWidthInput.value, 10);
    config.roiHeight = parseInt(roiHeightInput.value, 10);
    config.zoom = parseFloat(zoomInput.value);
    config.focusMode = focusModeSelect.value;
    config.resolution = resolutionSelect.value;
    config.stopOnCapture = stopOnCaptureEl.checked;
    config.beepOnCapture = beepOnCaptureEl.checked;
    config.verifyReads = verifyReadsEl.checked;
    config.cameraId = cameraSelect.value;

    localStorage.setItem("scanner_config", JSON.stringify(config));
    log("Settings saved.");
  }

  // Update slider displays immediately
  fpsInput.addEventListener("input", () => { fpsVal.textContent = fpsInput.value; });
  roiWidthInput.addEventListener("input", () => { roiWidthVal.textContent = roiWidthInput.value; });
  roiHeightInput.addEventListener("input", () => { roiHeightVal.textContent = roiHeightInput.value; });
  zoomInput.addEventListener("input", () => {
    const v = parseFloat(zoomInput.value);
    zoomVal.textContent = v.toFixed(1);
    applyZoomDirectly(v);
  });
  focusModeSelect.addEventListener("change", () => {
    applyFocusModeDirectly(focusModeSelect.value);
  });

  // Synthesize custom beep using Web Audio API
  function playBeep() {
    if (!config.beepOnCapture) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(1400, audioCtx.currentTime); // Sharp 1400Hz signal
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12); // Short 120ms fade

      osc.start();
      osc.stop(audioCtx.currentTime + 0.12);
    } catch (err) {
      console.error("Web Audio API synthesis failed:", err);
    }
  }

  // Gate 1: Checksum Math (Standard Modulo-10 alternate weights 1 & 3)
  function calculateEanChecksum(code) {
    let sum = 0;
    for (let i = 0; i < code.length - 1; i++) {
      let digit = parseInt(code[i], 10);
      if (isNaN(digit)) return -1;
      let weight = (code.length - 1 - i) % 2 === 0 ? 1 : 3;
      sum += digit * weight;
    }
    let mod = sum % 10;
    return mod === 0 ? 0 : 10 - mod;
  }

  function calculateUpcChecksum(code) {
    let sum = 0;
    for (let i = 0; i < code.length - 1; i++) {
      let digit = parseInt(code[i], 10);
      if (isNaN(digit)) return -1;
      let weight = (i % 2 === 0) ? 3 : 1;
      sum += digit * weight;
    }
    let mod = sum % 10;
    return mod === 0 ? 0 : 10 - mod;
  }

  function passesChecksum(text, formatName) {
    if (!text || typeof text !== "string") return false;
    const isNumeric = /^\d+$/.test(text);

    if (formatName === "EAN_13" && text.length === 13 && isNumeric) {
      const calc = calculateEanChecksum(text);
      const actual = parseInt(text[12], 10);
      return calc === actual;
    }
    if (formatName === "EAN_8" && text.length === 8 && isNumeric) {
      const calc = calculateEanChecksum(text);
      const actual = parseInt(text[7], 10);
      return calc === actual;
    }
    if (formatName === "UPC_A" && text.length === 12 && isNumeric) {
      const calc = calculateUpcChecksum(text);
      const actual = parseInt(text[11], 10);
      return calc === actual;
    }
    // QR codes, Code-128, Code-39 etc. use self-checking formats
    return true;
  }

  function saveCapturedList() {
    localStorage.setItem("scanner_captured", JSON.stringify(capturedList));
  }

  function updateCapturedUI() {
    capturedListEl.innerHTML = "";
    if (capturedList.length === 0) {
      const li = document.createElement("li");
      li.style.color = "#888";
      li.style.textAlign = "center";
      li.style.padding = "20px";
      li.style.fontSize = "13px";
      li.textContent = "No captured codes yet.";
      capturedListEl.appendChild(li);
      statCount.textContent = "0";
