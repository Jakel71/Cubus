(function () {
  "use strict";

  var Algo = window.CubusAlgo;
  var Vision = window.CubusVision;

  var FACE_ORDER = Algo.FACE_ORDER;
  var CENTER_LETTER_FOR_FACE = Algo.CENTER_LETTER_FOR_FACE;
  var TOP_COLOR_FOR_FACE = Algo.TOP_COLOR_FOR_FACE;
  var COLOR_LETTERS = Algo.COLOR_LETTERS;
  var DEFAULT_HSV = Algo.DEFAULT_HSV;
  var SWATCH_RGB = Algo.SWATCH_RGB;
  var GRID_SIZE = Algo.GRID_SIZE;
  var MAX_SAMPLES_PER_COLOR = Algo.MAX_SAMPLES_PER_COLOR;
  var CENTER_CELL = Math.floor((GRID_SIZE * GRID_SIZE) / 2); // 4

  var FRAMES_TO_SMOOTH = 6;
  var DETECT_INTERVAL_MS = 220;
  var SAMPLE_STRIDE = 3; // pixel stride when reading a sticker patch, for perf

  // ---------- DOM ----------
  var video = document.getElementById("video");
  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Hidden buffer that always holds the true, unmirrored camera frame.
  // Sticker sampling reads from THIS, never from the visible canvas, so the
  // "Mirror preview" checkbox is purely cosmetic and can never change what
  // colors get captured. See renderFrame() and readStickerHsv().
  var rawCanvas = document.createElement("canvas");
  var rawCtx = rawCanvas.getContext("2d", { willReadFrequently: true });

  var elHeader = document.getElementById("headerText");
  var elCounts = document.getElementById("countsText");
  var elCaptureBtn = document.getElementById("captureBtn");
  var elCalibrateBtn = document.getElementById("calibrateBtn");
  var elUndoBtn = document.getElementById("undoBtn");
  var elResetBtn = document.getElementById("resetBtn");
  var elFacingSelect = document.getElementById("facingSelect");
  var elMirrorCheck = document.getElementById("mirrorCheck");
  var elStatusLine = document.getElementById("statusLine");
  var elBanner = document.getElementById("captureBanner");
  var elBannerText = document.getElementById("captureBannerText");
  var elBannerEdit = document.getElementById("captureBannerEdit");
  var elBannerContinue = document.getElementById("captureBannerContinue");
  var elSolveSection = document.getElementById("solveSection");
  var elSolveBtn = document.getElementById("solveBtn");
  var elNewCubeBtn = document.getElementById("newCubeBtn");
  var elResults = document.getElementById("results");

  var elEditOverlay = document.getElementById("editOverlay");
  var elEditGrid = document.getElementById("editGrid");
  var elEditPalette = document.getElementById("editPalette");
  var elEditTitle = document.getElementById("editTitle");
  var elEditConfirm = document.getElementById("editConfirm");
  var elEditCancel = document.getElementById("editCancel");

  // ---------- State ----------
  var stream = null;
  var currentFacing = "environment";

  var references = {};
  var samplesByColor = {};
  COLOR_LETTERS.forEach(function (l) {
    references[l] = DEFAULT_HSV[l].slice();
    samplesByColor[l] = [];
  });

  var cells = []; // {x,y,w,h} in canvas pixel space, row-major
  var recentFrames = []; // array of [ [h,s,v] x9 ]
  var smoothedSamples = new Array(GRID_SIZE * GRID_SIZE).fill(0).map(function () { return [0, 0, 0]; });
  var liveLabels = new Array(GRID_SIZE * GRID_SIZE).fill("w");

  var capturedFaces = []; // array of 9-length hsv-triplet arrays, already unmirrored
  // Same faces, WITHOUT the unmirrorFace() correction. Whether a given
  // camera's raw feed needs that correction turns out to vary (it depends
  // on facing/device/browser), so we keep both orientations and let the
  // solver auto-pick whichever one comes out as a physically valid cube.
  // See computeStickerLetters() / the solve handler.
  var capturedFacesMirrored = [];
  var manualFaceLetters = {}; // faceIndex -> [9 letters]
  var faceIndex = 0;
  var pendingCaptureIndex = null; // face index currently shown in the capture banner
  var pendingCaptureIndex_editSeed = null; // unmirrored live labels captured at that moment, seeds the edit overlay

  // ---------- Calibration persistence ----------
  // NOTE: fetch("/api/calibration") only works when this page is loaded via
  // http(s):// (e.g. from the ESP32, or `python3 -m http.server`). If you
  // open index.html directly from disk (file://), the browser's same-origin
  // rule turns the relative URL into file:///api/calibration and refuses
  // it as a CORS violation. That's expected there - we just skip straight
  // to localStorage in that case instead of letting the console scream.
  var HAS_HTTP_ORIGIN = (window.location.protocol === "http:" || window.location.protocol === "https:");

  function loadCalibration() {
    var networkFetch = HAS_HTTP_ORIGIN
      ? fetch("/api/calibration").then(function (r) { return r.ok ? r.json() : {}; })
      : Promise.reject(new Error("no http origin"));

    networkFetch
      .catch(function () {
        try {
          var raw = localStorage.getItem("cubus_calibration");
          return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
      })
      .then(function (data) {
        var total = 0;
        COLOR_LETTERS.forEach(function (letter) {
          var samples = (data && data[letter]) || [];
          samplesByColor[letter] = samples;
          total += samples.length;
          if (samples.length) {
            references[letter] = Algo.weightedHsvMean(samples, samples.map(function () { return 1.0; }));
          }
        });
        if (total) setStatus("Loaded " + total + " saved calibration samples");
        updateCounts();
      });
  }

  var saveTimer = null;
  function saveCalibration() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var body = JSON.stringify(samplesByColor);
      if (HAS_HTTP_ORIGIN) {
        fetch("/api/calibration", { method: "POST", headers: { "Content-Type": "application/json" }, body: body })
          .catch(function () {});
      }
      try { localStorage.setItem("cubus_calibration", body); } catch (e) {}
    }, 150);
  }

  function resetCalibrationOnServer() {
    if (HAS_HTTP_ORIGIN) {
      fetch("/api/calibration/reset", { method: "POST" }).catch(function () {});
    }
    try { localStorage.removeItem("cubus_calibration"); } catch (e) {}
  }

  function calibrate(letter, sample) {
    var samples = samplesByColor[letter];
    samples.push(sample.slice());
    if (samples.length > MAX_SAMPLES_PER_COLOR) samples.shift();
    references[letter] = Algo.weightedHsvMean(samples, samples.map(function () { return 1.0; }));
    saveCalibration();
    updateCounts();
  }

  // ---------- Camera ----------
  function startCamera() {
    // On an insecure origin (plain http:// to anything other than
    // localhost/127.0.0.1 - which is exactly how the ESP32 serves this
    // page over your LAN), browsers don't reject getUserMedia with a
    // catchable error - they don't expose navigator.mediaDevices at all.
    // Calling .getUserMedia on it then throws a *synchronous* TypeError
    // before any promise exists, so the .catch() below never runs and
    // nothing gets shown. Check up front instead, so this fails loudly
    // with an actionable message rather than silently doing nothing.
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera blocked: this page isn't a \"secure origin\" (needs https://, or localhost)");
      elHeader.textContent =
        "Camera unavailable on this connection. Browsers only allow camera " +
        "access on HTTPS pages or on localhost - plain http://" + window.location.hostname +
        " doesn't qualify. On Android Chrome/desktop Chrome you can allow it via " +
        "chrome://flags/#unsafely-treat-insecure-origin-as-secure (add this page's " +
        "http://... address, enable, relaunch). iOS Safari has no such flag - see the " +
        "README's HTTPS section for workarounds.";
      return;
    }

    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    var constraints = {
      audio: false,
      video: {
        facingMode: { ideal: currentFacing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
    navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play();
    }).then(function () {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      rawCanvas.width = canvas.width;
      rawCanvas.height = canvas.height;
      cells = buildGrid(canvas.width, canvas.height);
    }).catch(function (err) {
      setStatus("Camera error: " + err.message);
    });
  }

  // Fraction of the frame's short side taken by one sticker cell. The whole
  // 3x3 outline spans 3.28x this (3 cells + 2 gaps of 0.14 cell each), so the
  // hard ceiling is 1/3.28 = 0.305 before the grid runs off the top and bottom
  // edges. 0.27 puts the outline at ~89% of the short side, which leaves just
  // enough margin to see the cube's edges while lining it up.
  var CELL_FRACTION_OF_FRAME = 0.27;

  function buildGrid(frameW, frameH) {
    var cellSizePx = Math.round(Math.min(frameW, frameH) * CELL_FRACTION_OF_FRAME);
    var cellGapPx = Math.round(cellSizePx * 0.14);
    var gridSpan = GRID_SIZE * cellSizePx + (GRID_SIZE - 1) * cellGapPx;
    var left = Math.round(frameW / 2 - gridSpan / 2);
    var top = Math.round(frameH / 2 - gridSpan / 2);

    var result = [];
    for (var row = 0; row < GRID_SIZE; row++) {
      for (var col = 0; col < GRID_SIZE; col++) {
        var x = left + col * (cellSizePx + cellGapPx);
        var y = top + row * (cellSizePx + cellGapPx);
        result.push({ x: x, y: y, w: cellSizePx, h: cellSizePx });
      }
    }
    return result;
  }

  // ---------- Detection ----------
  function readStickerHsv(cell) {
    var inset = Math.round(cell.w * 0.3);
    var px = cell.x + inset, py = cell.y + inset;
    var pw = cell.w - 2 * inset, ph = cell.h - 2 * inset;
    if (pw <= 0 || ph <= 0) return [0, 0, 0];
    if (px < 0 || py < 0 || px + pw > rawCanvas.width || py + ph > rawCanvas.height) return [0, 0, 0];

    var imgData;
    try {
      imgData = rawCtx.getImageData(px, py, pw, ph);
    } catch (e) {
      return [0, 0, 0];
    }
    var data = imgData.data;
    var pixels = [];
    var stride = SAMPLE_STRIDE * 4;
    for (var i = 0; i < data.length; i += stride) {
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return Vision.dominantClusterHsv(pixels);
  }

  function circularMeanHue(hues) {
    var sumCos = 0, sumSin = 0;
    hues.forEach(function (h) {
      var rad = h * (Math.PI / 90.0);
      sumCos += Math.cos(rad);
      sumSin += Math.sin(rad);
    });
    var angle = Math.atan2(sumSin / hues.length, sumCos / hues.length);
    if (angle < 0) angle += 2 * Math.PI;
    return angle * (90.0 / Math.PI);
  }

  function detectTick() {
    if (!cells.length || video.readyState < 2) return;

    var thisFrame = cells.map(readStickerHsv);
    recentFrames.push(thisFrame);
    if (recentFrames.length > FRAMES_TO_SMOOTH) recentFrames.shift();

    var n = cells.length;
    for (var cellIndex = 0; cellIndex < n; cellIndex++) {
      var hues = [], sats = [], vals = [];
      recentFrames.forEach(function (frame) {
        hues.push(frame[cellIndex][0]);
        sats.push(frame[cellIndex][1]);
        vals.push(frame[cellIndex][2]);
      });
      var meanSat = sats.reduce(function (a, b) { return a + b; }, 0) / sats.length;
      var meanVal = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      smoothedSamples[cellIndex] = [circularMeanHue(hues), meanSat, meanVal];
    }

    liveLabels = smoothedSamples.map(function (sample) {
      var best = COLOR_LETTERS[0], bestDist = Infinity;
      COLOR_LETTERS.forEach(function (letter) {
        var d = Algo.hsvDistance(sample, references[letter]);
        if (d < bestDist) { bestDist = d; best = letter; }
      });
      return best;
    });

    updateHeader();
  }

  // ---------- Render loop (video + grid overlay) ----------
  function renderFrame() {
    if (video.readyState >= 2) {
      // Always capture the true, unmirrored frame here first.
      rawCtx.drawImage(video, 0, 0, rawCanvas.width, rawCanvas.height);

      // The visible canvas is drawn FROM the raw buffer, with an optional
      // flip applied only for on-screen display. readStickerHsv() never
      // touches this canvas, so toggling the checkbox can't affect capture.
      ctx.save();
      if (elMirrorCheck.checked) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(rawCanvas, 0, 0);
      ctx.restore();

      cells.forEach(function (cell, i) {
        var label = liveLabels[i] || "w";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "black";
        ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "white";
        ctx.strokeRect(cell.x + 1.5, cell.y + 1.5, cell.w - 3, cell.h - 3);

        var swatchSize = Math.max(14, cell.w * 0.32);
        ctx.fillStyle = SWATCH_RGB[label];
        ctx.fillRect(cell.x + 4, cell.y + 4, swatchSize, swatchSize);
        ctx.strokeStyle = "black";
        ctx.lineWidth = 1;
        ctx.strokeRect(cell.x + 4, cell.y + 4, swatchSize, swatchSize);

        ctx.font = Math.max(12, Math.round(cell.h * 0.32)) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "black";
        ctx.strokeText(label.toUpperCase(), cell.x + cell.w / 2, cell.y + cell.h / 2 + swatchSize * 0.4);
        ctx.fillStyle = "white";
        ctx.fillText(label.toUpperCase(), cell.x + cell.w / 2, cell.y + cell.h / 2 + swatchSize * 0.4);
      });
    }
    requestAnimationFrame(renderFrame);
  }

  // ---------- UI updates ----------
  function updateHeader() {
    if (faceIndex < FACE_ORDER.length) {
      var face = FACE_ORDER[faceIndex];
      var expectedCenter = CENTER_LETTER_FOR_FACE[face].toUpperCase();
      var expectedTop = TOP_COLOR_FOR_FACE[face].toUpperCase();
      elHeader.textContent = "Face " + (faceIndex + 1) + "/6: " + face + " \u2014 center must be " + expectedCenter + ", keep " + expectedTop + " on top";
      elCaptureBtn.disabled = false;
      elCalibrateBtn.disabled = false;
    } else {
      elHeader.textContent = "All 6 faces captured";
      elCaptureBtn.disabled = true;
      elCalibrateBtn.disabled = true;
    }
  }

  function updateCounts() {
    var parts = COLOR_LETTERS.map(function (letter) {
      return letter.toUpperCase() + ":" + samplesByColor[letter].length;
    });
    elCounts.textContent = parts.join("  ");
  }

  function setStatus(text) {
    elStatusLine.textContent = text || "";
  }

  function updateSolveVisibility() {
    elSolveSection.style.display = capturedFaces.length >= FACE_ORDER.length ? "block" : "none";
  }

  // ---------- Capture flow ----------
  elCaptureBtn.addEventListener("click", function () {
    if (faceIndex >= FACE_ORDER.length) return;
    var face = FACE_ORDER[faceIndex];
    var letter = CENTER_LETTER_FOR_FACE[face];
    calibrate(letter, smoothedSamples[CENTER_CELL]);

    var snapshot = smoothedSamples.map(function (s) { return s.slice(); });
    var unmirrored = Algo.unmirrorFace(snapshot);
    capturedFaces.push(unmirrored);
    capturedFacesMirrored.push(snapshot);

    var unmirroredLabels = Algo.unmirrorFace(liveLabels.slice());
    pendingCaptureIndex = faceIndex;
    pendingCaptureIndex_editSeed = unmirroredLabels;

    elBannerText.textContent = "Face " + face + " captured.";
    elBanner.style.display = "flex";
    setStatus("");
  });

  elBannerContinue.addEventListener("click", function () {
    elBanner.style.display = "none";
    advanceAfterCapture();
  });

  elBannerEdit.addEventListener("click", function () {
    var face = FACE_ORDER[pendingCaptureIndex];
    elBanner.style.display = "none";
    openEditOverlay(face, pendingCaptureIndex_editSeed, function (editedLetters) {
      if (editedLetters) {
        manualFaceLetters[pendingCaptureIndex] = editedLetters;
        setStatus("Edited " + face + " manually");
      }
      advanceAfterCapture();
    });
  });

  function advanceAfterCapture() {
    faceIndex += 1;
    updateHeader();
    updateSolveVisibility();
    if (faceIndex >= FACE_ORDER.length) {
      setStatus("All faces captured \u2014 scroll down to solve");
    }
  }

  elCalibrateBtn.addEventListener("click", function () {
    if (faceIndex >= FACE_ORDER.length) return;
    var letter = CENTER_LETTER_FOR_FACE[FACE_ORDER[faceIndex]];
    calibrate(letter, smoothedSamples[CENTER_CELL]);
    var hsv = references[letter];
    setStatus("Calibrated " + letter.toUpperCase() + " (" + samplesByColor[letter].length + " samples) -> H" +
      hsv[0].toFixed(0) + " S" + hsv[1].toFixed(0) + " V" + hsv[2].toFixed(0));
  });

  elUndoBtn.addEventListener("click", function () {
    if (!capturedFaces.length) return;
    capturedFaces.pop();
    capturedFacesMirrored.pop();
    faceIndex -= 1;
    delete manualFaceLetters[faceIndex];
    updateHeader();
    updateSolveVisibility();
    setStatus("Undid face, now on " + FACE_ORDER[faceIndex]);
  });

  elResetBtn.addEventListener("click", function () {
    references = {};
    samplesByColor = {};
    COLOR_LETTERS.forEach(function (l) { references[l] = DEFAULT_HSV[l].slice(); samplesByColor[l] = []; });
    capturedFaces = [];
    capturedFacesMirrored = [];
    manualFaceLetters = {};
    faceIndex = 0;
    elResults.innerHTML = "";
    resetCalibrationOnServer();
    clearInterval(solutionPollTimer);
    updateCounts();
    updateHeader();
    updateSolveVisibility();
    setStatus("Reset");
  });

  // Start a fresh scan without touching `references` / `samplesByColor`, so the
  // color calibration built up during the last cube (and anything loaded from
  // the server / localStorage) carries straight over to the next one. This is
  // the difference from "Reset all", which deliberately wipes calibration too.
  elNewCubeBtn.addEventListener("click", function () {
    capturedFaces = [];
    capturedFacesMirrored = [];
    manualFaceLetters = {};
    faceIndex = 0;
    pendingCaptureIndex = null;
    pendingCaptureIndex_editSeed = null;
    elBanner.style.display = "none";
    elResults.innerHTML = "";
    clearInterval(solutionPollTimer);
    updateHeader();
    updateSolveVisibility();
    setStatus("New scan — calibration kept");
  });

  elFacingSelect.addEventListener("change", function () {
    currentFacing = elFacingSelect.value;
    elMirrorCheck.checked = currentFacing === "user";
    startCamera();
  });

  // ---------- Manual edit overlay ----------
  function buildEditGridDom() {
    elEditGrid.innerHTML = "";
    var cellsDom = [];
    for (var i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
      var div = document.createElement("div");
      div.className = "editCell";
      div.dataset.index = String(i);
      elEditGrid.appendChild(div);
      cellsDom.push(div);
    }
    return cellsDom;
  }

  function buildEditPaletteDom(onPick) {
    elEditPalette.innerHTML = "";
    COLOR_LETTERS.forEach(function (letter) {
      var div = document.createElement("div");
      div.className = "swatch";
      div.style.background = SWATCH_RGB[letter];
      div.textContent = letter.toUpperCase();
      div.addEventListener("click", function () { onPick(letter); });
      elEditPalette.appendChild(div);
    });
  }

  function openEditOverlay(face, initialLetters, onDone) {
    var letters = initialLetters.slice();
    letters[CENTER_CELL] = CENTER_LETTER_FOR_FACE[face];
    var currentColor = COLOR_LETTERS[0];

    var cellsDom = buildEditGridDom();

    function paint() {
      cellsDom.forEach(function (div, i) {
        div.style.background = SWATCH_RGB[letters[i]];
        div.classList.toggle("centerCell", i === CENTER_CELL);
      });
      Array.prototype.forEach.call(elEditPalette.children, function (child, idx) {
        child.classList.toggle("selected", COLOR_LETTERS[idx] === currentColor);
      });
    }

    buildEditPaletteDom(function (letter) { currentColor = letter; paint(); });

    cellsDom.forEach(function (div, i) {
      div.addEventListener("click", function () {
        if (i === CENTER_CELL) return;
        letters[i] = currentColor;
        paint();
      });
    });

    elEditTitle.textContent = "Editing face " + face;
    paint();
    elEditOverlay.style.display = "flex";

    function cleanup() {
      elEditOverlay.style.display = "none";
      elEditConfirm.removeEventListener("click", onConfirm);
      elEditCancel.removeEventListener("click", onCancel);
    }
    function onConfirm() { cleanup(); onDone(letters); }
    function onCancel() { cleanup(); onDone(null); }

    elEditConfirm.addEventListener("click", onConfirm);
    elEditCancel.addEventListener("click", onCancel);
  }

  // ---------- Solve ----------
  // cubejs's Cube.fromString() happily builds a Cube object out of any
  // facelet string, even one that is physically impossible (e.g. two
  // stickers swapped by a scanning mistake). cube.solve() has no idea
  // it's impossible - it just runs IDA* up to depth 22 looking for a
  // solution that can never be found, which for an illegal cube means
  // exhausting a gigantic search tree on the main thread. That's what
  // was freezing the tab. So: verify legality ourselves first and bail
  // out immediately with a helpful message if the scan doesn't check out.
  function findIllegalCubeReason(cube) {
    var seenCp = {}, i;
    for (i = 0; i < cube.cp.length; i++) {
      if (seenCp[cube.cp[i]]) return "a corner piece appears twice";
      seenCp[cube.cp[i]] = true;
    }
    var seenEp = {};
    for (i = 0; i < cube.ep.length; i++) {
      if (seenEp[cube.ep[i]]) return "an edge piece appears twice";
      seenEp[cube.ep[i]] = true;
    }
    var coSum = cube.co.reduce(function (a, b) { return a + b; }, 0);
    if (coSum % 3 !== 0) return "corner orientations don't add up (a corner sticker is probably misread)";
    var eoSum = cube.eo.reduce(function (a, b) { return a + b; }, 0);
    if (eoSum % 2 !== 0) return "edge orientations don't add up (an edge sticker is probably misread)";
    if (cube.cornerParity() !== cube.edgeParity()) return "corner/edge permutation parity mismatch (two stickers are likely swapped)";
    return null;
  }

  var solverReady = false;
  function initSolverAsync() {
    setStatus("Loading solver engine\u2026");
    elSolveBtn.disabled = true;
    setTimeout(function () {
      try {
        window.Cube.initSolver();
        solverReady = true;
        elSolveBtn.disabled = false;
        setStatus("Solver ready");
      } catch (e) {
        setStatus("Solver failed to load: " + e.message);
      }
    }, 30);
  }

  // Runs the same color-assignment pipeline that used to be inline in the
  // click handler, but parameterized on which set of per-face samples/manual
  // overrides to use - so it can be called once for the standard orientation
  // and once for the mirrored one.
  function computeStickerLetters(faces, manualLetters) {
    var allSamples = [];
    faces.forEach(function (face) { face.forEach(function (s) { allSamples.push(s); }); });

    var knownCenters = {};
    FACE_ORDER.forEach(function (face, i) {
      knownCenters[CENTER_LETTER_FOR_FACE[face]] = faces[i][CENTER_CELL];
    });

    var fixedLabels = {};
    FACE_ORDER.forEach(function (face, i) {
      fixedLabels[i * 9 + CENTER_CELL] = CENTER_LETTER_FOR_FACE[face];
    });
    Object.keys(manualLetters).forEach(function (faceIdxStr) {
      var faceIdx = parseInt(faceIdxStr, 10);
      manualLetters[faceIdx].forEach(function (letter, cellIdx) {
        fixedLabels[faceIdx * 9 + cellIdx] = letter;
      });
    });

    var out = Algo.solveFaceColors(allSamples, references, knownCenters, fixedLabels);
    return out.labels;
  }

  elSolveBtn.addEventListener("click", function () {
    if (!solverReady) { setStatus("Solver still loading, please wait\u2026"); return; }
    if (capturedFaces.length < FACE_ORDER.length) return;

    // manualFaceLetters holds edits made in the standard orientation. For
    // the mirrored candidate, the same edits need mirroring too (unmirrorFace
    // is its own inverse, so applying it again converts standard -> mirrored).
    var mirroredManualLetters = {};
    Object.keys(manualFaceLetters).forEach(function (faceIdxStr) {
      mirroredManualLetters[faceIdxStr] = Algo.unmirrorFace(manualFaceLetters[faceIdxStr]);
    });

    var standardLetters = computeStickerLetters(capturedFaces, manualFaceLetters);
    var mirroredLetters = computeStickerLetters(capturedFacesMirrored, mirroredManualLetters);

    renderResults(standardLetters, mirroredLetters);
  });

  // Checks one candidate sticker-letter array for validity (color counts,
  // parseable facelet string, legal permutation/orientation). Returns
  // { ok: true, cube, kociembaString } or { ok: false, reason }.
  function evaluateCandidate(stickerLetters) {
    var counts = {};
    COLOR_LETTERS.forEach(function (l) { counts[l] = 0; });
    stickerLetters.forEach(function (l) { counts[l] += 1; });
    var bad = COLOR_LETTERS.filter(function (l) { return counts[l] !== 9; });
    if (bad.length) {
      return { ok: false, reason: "each color needs exactly 9 stickers: " +
        bad.map(function (l) { return l.toUpperCase() + "=" + counts[l]; }).join(", ") };
    }

    var kociembaString = Algo.lettersToKociembaString(stickerLetters);

    var cube;
    try {
      cube = window.Cube.fromString(kociembaString);
    } catch (e) {
      return { ok: false, reason: "scan has an error (" + e.message + ")" };
    }

    var illegalReason = findIllegalCubeReason(cube);
    if (illegalReason) {
      return { ok: false, reason: "not a physically valid cube state (" + illegalReason + ")" };
    }

    return { ok: true, cube: cube, kociembaString: kociembaString };
  }

  function renderResults(standardLetters, mirroredLetters) {
    elResults.innerHTML = "";

    var standardResult = evaluateCandidate(standardLetters);
    var usedMirrored = false;
    var chosen = standardResult;
    var stickerLetters = standardLetters;

    // Whether the raw camera feed needs the left/right sticker correction
    // varies by facing/device/browser. If the standard orientation comes out
    // physically invalid, automatically retry with the opposite orientation
    // before giving up, instead of assuming the scan itself was bad.
    if (!standardResult.ok) {
      var mirroredResult = evaluateCandidate(mirroredLetters);
      if (mirroredResult.ok) {
        chosen = mirroredResult;
        stickerLetters = mirroredLetters;
        usedMirrored = true;
      }
    }

    var pre = document.createElement("pre");
    pre.className = "resultBlock";
    var lines = [];
    FACE_ORDER.forEach(function (face, i) {
      lines.push(face + ": " + stickerLetters.slice(i * 9, i * 9 + 9).join("").toUpperCase());
    });
    pre.textContent = lines.join("\n");
    elResults.appendChild(pre);

    if (!chosen.ok) {
      var warn = document.createElement("div");
      warn.className = "warnBlock";
      warn.textContent = "Couldn't find a valid cube in either camera orientation \u2014 standard: " +
        standardResult.reason + "; mirrored: " + evaluateCandidate(mirroredLetters).reason +
        ". Fix a face with Undo + Edit, then solve again.";
      elResults.appendChild(warn);
      setStatus("Solve failed");
      return;
    }

    if (usedMirrored) {
      var autoLine = document.createElement("div");
      autoLine.className = "warnBlock";
      autoLine.textContent = "Standard orientation wasn't a valid cube (" + standardResult.reason +
        "), so this was auto-corrected to the mirrored orientation.";
      elResults.appendChild(autoLine);
    }

    var kLine = document.createElement("div");
    kLine.className = "resultBlock";
    kLine.textContent = "Facelets: " + chosen.kociembaString;
    elResults.appendChild(kLine);

    var cube = chosen.cube;

    setStatus("Solving\u2026");
    elSolveBtn.disabled = true;
    // Yield one frame so "Solving..." actually paints before the
    // (synchronous, CPU-heavy) search runs.
    requestAnimationFrame(function () {
      setTimeout(function () {
        try {
          var solution = cube.solve();
          var solLine = document.createElement("div");
          solLine.className = "solutionBlock";
          solLine.textContent = solution;
          elResults.appendChild(solLine);
          setStatus("Solved");
          appendRobotControls(solution);
        } catch (e) {
          var errLine = document.createElement("div");
          errLine.className = "warnBlock";
          errLine.textContent = "Unsolvable \u2014 scan has an error (" + e.message + ")";
          elResults.appendChild(errLine);
          setStatus("Solve failed");
        } finally {
          elSolveBtn.disabled = false;
        }
      }, 0);
    });
  }

  // ---------- Robot control (ESP32 -> Arduino) ----------
  // Sends the solved move list to the ESP32 as a plain-text body (same
  // pattern as the calibration endpoints - no JSON parsing needed on the
  // device). The ESP32 relays moves to the Arduino over UART one at a time,
  // waiting for an "OK" acknowledgement between moves; we poll
  // /api/solution/status to show progress here without blocking on it.
  var solutionPollTimer = null;

  function appendRobotControls(solutionText) {
    if (!HAS_HTTP_ORIGIN) return; // nothing to send to when opened as a file

    var row = document.createElement("div");
    row.className = "resultBlock";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "12px";
    row.style.flexWrap = "wrap";

    var sendBtn = document.createElement("button");
    sendBtn.className = "primary";
    sendBtn.textContent = "Send to Cubus robot";

    var progressText = document.createElement("span");
    progressText.style.fontFamily = "inherit";

    row.appendChild(sendBtn);
    row.appendChild(progressText);
    elResults.appendChild(row);

    sendBtn.addEventListener("click", function () {
      clearInterval(solutionPollTimer);
      sendBtn.disabled = true;
      progressText.textContent = "Sending to robot\u2026";

      fetch("/api/solution", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: solutionText
      })
        .then(function (r) {
          return r.text().then(function (text) {
            var data;
            try { data = JSON.parse(text); } catch (e) { data = {}; }
            return { httpOk: r.ok, data: data };
          });
        })
        .then(function (res) {
          if (!res.httpOk || !res.data.ok) {
            progressText.textContent = "Robot rejected the solution" +
              (res.data && res.data.error ? ": " + res.data.error : "");
            sendBtn.disabled = false;
            return;
          }
          watchSolutionProgress(progressText, sendBtn);
        })
        .catch(function (err) {
          progressText.textContent = "Couldn't reach the robot: " + err.message;
          sendBtn.disabled = false;
        });
    });
  }

  function watchSolutionProgress(progressText, sendBtn) {
    clearInterval(solutionPollTimer);
    solutionPollTimer = setInterval(function () {
      fetch("/api/solution/status")
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s.state === "running") {
            progressText.textContent = "Move " + (s.currentIndex + 1) + "/" + s.moveCount +
              ": " + s.currentMove;
          } else if (s.state === "done") {
            progressText.textContent = "Done \u2014 the robot finished the solve.";
            clearInterval(solutionPollTimer);
            sendBtn.disabled = false;
          } else if (s.state === "error") {
            progressText.textContent = "Robot error at move " + (s.currentIndex + 1) +
              "/" + s.moveCount + ": " + s.error;
            clearInterval(solutionPollTimer);
            sendBtn.disabled = false;
          }
          // state === "idle" between the POST landing and the ESP32 picking
          // it up - just keep polling silently.
        })
        .catch(function () {
          // Transient network hiccup - keep polling rather than giving up.
        });
    }, 400);
  }

  // ---------- Boot ----------
  function boot() {
    loadCalibration();
    updateCounts();
    updateHeader();
    updateSolveVisibility();
    elMirrorCheck.checked = currentFacing === "user";
    startCamera();
    initSolverAsync();
    setInterval(detectTick, DETECT_INTERVAL_MS);
    requestAnimationFrame(renderFrame);
  }

  window.addEventListener("load", boot);
})();
