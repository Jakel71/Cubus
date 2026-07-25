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
      cells = buildGrid(canvas.width, canvas.height);
    }).catch(function (err) {
      setStatus("Camera error: " + err.message);
    });
  }

  function buildGrid(frameW, frameH) {
    var cellSizePx = Math.round(Math.min(frameW, frameH) * 0.19);
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
    if (px < 0 || py < 0 || px + pw > canvas.width || py + ph > canvas.height) return [0, 0, 0];

    var imgData;
    try {
      imgData = ctx.getImageData(px, py, pw, ph);
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
      ctx.save();
      if (elMirrorCheck.checked) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
    manualFaceLetters = {};
    faceIndex = 0;
    elResults.innerHTML = "";
    resetCalibrationOnServer();
    updateCounts();
    updateHeader();
    updateSolveVisibility();
    setStatus("Reset");
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

  elSolveBtn.addEventListener("click", function () {
    if (!solverReady) { setStatus("Solver still loading, please wait\u2026"); return; }
    if (capturedFaces.length < FACE_ORDER.length) return;

    var allSamples = [];
    capturedFaces.forEach(function (face) { face.forEach(function (s) { allSamples.push(s); }); });

    var knownCenters = {};
    FACE_ORDER.forEach(function (face, i) {
      knownCenters[CENTER_LETTER_FOR_FACE[face]] = capturedFaces[i][CENTER_CELL];
    });

    var fixedLabels = {};
    FACE_ORDER.forEach(function (face, i) {
      fixedLabels[i * 9 + CENTER_CELL] = CENTER_LETTER_FOR_FACE[face];
    });
    Object.keys(manualFaceLetters).forEach(function (faceIdxStr) {
      var faceIdx = parseInt(faceIdxStr, 10);
      manualFaceLetters[faceIdx].forEach(function (letter, cellIdx) {
        fixedLabels[faceIdx * 9 + cellIdx] = letter;
      });
    });

    var out = Algo.solveFaceColors(allSamples, references, knownCenters, fixedLabels);
    var stickerLetters = out.labels;

    renderResults(stickerLetters);
  });

  function renderResults(stickerLetters) {
    elResults.innerHTML = "";

    var counts = {};
    COLOR_LETTERS.forEach(function (l) { counts[l] = 0; });
    stickerLetters.forEach(function (l) { counts[l] += 1; });
    var bad = COLOR_LETTERS.filter(function (l) { return counts[l] !== 9; });

    var pre = document.createElement("pre");
    pre.className = "resultBlock";
    var lines = [];
    FACE_ORDER.forEach(function (face, i) {
      lines.push(face + ": " + stickerLetters.slice(i * 9, i * 9 + 9).join("").toUpperCase());
    });
    pre.textContent = lines.join("\n");
    elResults.appendChild(pre);

    if (bad.length) {
      var warn = document.createElement("div");
      warn.className = "warnBlock";
      warn.textContent = "Each color needs exactly 9 stickers: " +
        bad.map(function (l) { return l.toUpperCase() + "=" + counts[l]; }).join(", ") +
        ". Fix a face with Undo + Edit, then solve again.";
      elResults.appendChild(warn);
      return;
    }

    var kociembaString = Algo.lettersToKociembaString(stickerLetters);
    var kLine = document.createElement("div");
    kLine.className = "resultBlock";
    kLine.textContent = "Facelets: " + kociembaString;
    elResults.appendChild(kLine);

    var cube;
    try {
      cube = window.Cube.fromString(kociembaString);
    } catch (e) {
      var parseErrLine = document.createElement("div");
      parseErrLine.className = "warnBlock";
      parseErrLine.textContent = "Scan has an error (" + e.message + "). Fix a face with Undo + Edit, then solve again.";
      elResults.appendChild(parseErrLine);
      setStatus("Solve failed");
      return;
    }

    var illegalReason = findIllegalCubeReason(cube);
    if (illegalReason) {
      var illegalLine = document.createElement("div");
      illegalLine.className = "warnBlock";
      illegalLine.textContent = "This isn't a physically valid cube state (" + illegalReason +
        "). That means at least one sticker was misread during scanning. Fix the affected face with Undo + Edit, then solve again.";
      elResults.appendChild(illegalLine);
      setStatus("Solve failed \u2014 invalid scan");
      return;
    }

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
