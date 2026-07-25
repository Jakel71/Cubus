/*
 * Cubus color-matching algorithm.
 * Ported from cube_scanner.py (Python/OpenCV) to plain JavaScript.
 * No DOM / canvas dependency here - this file is pure math so it can run
 * both in the browser and under Node for testing.
 */
(function (root) {
  "use strict";

  var FACE_ORDER = ["U", "R", "F", "D", "L", "B"];

  var CENTER_LETTER_FOR_FACE = { U: "y", R: "r", F: "b", D: "w", L: "o", B: "g" };
  var TOP_COLOR_FOR_FACE = { U: "g", R: "y", F: "y", D: "b", L: "y", B: "y" };

  var COLOR_LETTERS = ["w", "y", "r", "o", "g", "b"];

  // OpenCV-style HSV: H in [0,180), S,V in [0,255]
  var DEFAULT_HSV = {
    w: [0.0, 18.0, 225.0],
    y: [28.0, 200.0, 220.0],
    r: [2.0, 215.0, 180.0],
    o: [11.0, 225.0, 225.0],
    g: [65.0, 190.0, 150.0],
    b: [108.0, 205.0, 180.0]
  };

  // CSS rgb() colors for swatches (converted from the Python BGR tuples)
  var SWATCH_RGB = {
    w: "rgb(235,235,235)",
    y: "rgb(255,215,0)",
    r: "rgb(210,40,40)",
    o: "rgb(255,140,0)",
    g: "rgb(60,160,60)",
    b: "rgb(0,90,200)"
  };

  var LETTER_TO_FACE_CHAR = { y: "U", r: "R", b: "F", w: "D", o: "L", g: "B" };

  var GRID_SIZE = 3;
  var MAX_SAMPLES_PER_COLOR = 30;

  function hueDistance(hueA, hueB) {
    var diff = Math.abs(hueA - hueB) % 180.0;
    return Math.min(diff, 180.0 - diff);
  }

  function hsvDistance(sample, reference) {
    var hueGap = hueDistance(sample[0], reference[0]) / 90.0;
    var sharedSaturation = Math.min(sample[1], reference[1]) / 255.0;
    var satGap = Math.abs(sample[1] - reference[1]) / 255.0;
    var valGap = Math.abs(sample[2] - reference[2]) / 255.0;
    return hueGap * sharedSaturation * 5.0 + satGap * 1.2 + valGap * 0.2;
  }

  function buildCostMatrix(samples, references) {
    return samples.map(function (sample) {
      return COLOR_LETTERS.map(function (letter) {
        return hsvDistance(sample, references[letter]);
      });
    });
  }

  function argsortAsc(arr) {
    var idx = arr.map(function (_, i) { return i; });
    idx.sort(function (a, b) { return arr[a] - arr[b]; });
    return idx;
  }

  function assignWithQuota(samples, references, quotas) {
    var costs = buildCostMatrix(samples, references);
    var stickerCount = samples.length;
    var remaining = {};
    COLOR_LETTERS.forEach(function (letter) {
      remaining[letter] = quotas ? quotas[letter] : 9;
    });
    var assigned = new Array(stickerCount).fill(null);

    var confidenceOrder = [];
    for (var index = 0; index < stickerCount; index++) {
      var ranked = argsortAsc(costs[index]);
      confidenceOrder.push([costs[index][ranked[1]] - costs[index][ranked[0]], index]);
    }
    // sort descending by confidence gap
    confidenceOrder.sort(function (a, b) { return b[0] - a[0]; });

    confidenceOrder.forEach(function (pair) {
      var index = pair[1];
      var order = argsortAsc(costs[index]);
      for (var k = 0; k < order.length; k++) {
        var letter = COLOR_LETTERS[order[k]];
        if (remaining[letter] > 0) {
          assigned[index] = letter;
          remaining[letter] -= 1;
          break;
        }
      }
    });

    var swappedSomething = true;
    while (swappedSomething) {
      swappedSomething = false;
      for (var first = 0; first < stickerCount; first++) {
        for (var second = first + 1; second < stickerCount; second++) {
          var letterA = assigned[first];
          var letterB = assigned[second];
          if (letterA === letterB) continue;

          var indexA = COLOR_LETTERS.indexOf(letterA);
          var indexB = COLOR_LETTERS.indexOf(letterB);
          var currentCost = costs[first][indexA] + costs[second][indexB];
          var swappedCost = costs[first][indexB] + costs[second][indexA];

          if (swappedCost < currentCost - 1e-9) {
            assigned[first] = letterB;
            assigned[second] = letterA;
            swappedSomething = true;
          }
        }
      }
    }

    return assigned;
  }

  function weightedHsvMean(samples, weights) {
    var sumCos = 0, sumSin = 0, sumHueW = 0, sumSat = 0, sumVal = 0, sumW = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      var w = weights[i];
      var hueRad = s[0] * (Math.PI / 90.0);
      var hueW = w * (s[1] + 1.0);
      sumCos += Math.cos(hueRad) * hueW;
      sumSin += Math.sin(hueRad) * hueW;
      sumHueW += hueW;
      sumSat += s[1] * w;
      sumVal += s[2] * w;
      sumW += w;
    }
    var meanX = sumCos / sumHueW;
    var meanY = sumSin / sumHueW;
    var meanHue = (mod2pi(Math.atan2(meanY, meanX))) * (90.0 / Math.PI);
    return [meanHue, sumSat / sumW, sumVal / sumW];
  }

  function mod2pi(angle) {
    var twoPi = 2 * Math.PI;
    var r = angle % twoPi;
    return r < 0 ? r + twoPi : r;
  }

  function unmirrorFace(values) {
    var unmirrored = [];
    for (var row = 0; row < GRID_SIZE; row++) {
      var rowValues = values.slice(row * GRID_SIZE, (row + 1) * GRID_SIZE);
      rowValues.reverse();
      unmirrored = unmirrored.concat(rowValues);
    }
    return unmirrored;
  }

  function solveFaceColors(samples, references, knownCenters, fixedLabels, maxRounds) {
    fixedLabels = fixedLabels || {};
    maxRounds = maxRounds || 12;

    var refs = {};
    COLOR_LETTERS.forEach(function (letter) { refs[letter] = references[letter].slice(); });

    var freeIndices = [];
    for (var i = 0; i < samples.length; i++) {
      if (!(i in fixedLabels)) freeIndices.push(i);
    }

    var baseQuota = {};
    COLOR_LETTERS.forEach(function (letter) { baseQuota[letter] = 9; });
    Object.keys(fixedLabels).forEach(function (key) {
      baseQuota[fixedLabels[key]] -= 1;
    });

    var previousLabels = null;
    var labels = null;

    for (var round = 0; round < maxRounds; round++) {
      var freeSamples = freeIndices.map(function (idx) { return samples[idx]; });
      var quotaCopy = {};
      COLOR_LETTERS.forEach(function (letter) { quotaCopy[letter] = baseQuota[letter]; });
      var freeLabels = assignWithQuota(freeSamples, refs, quotaCopy);

      labels = new Array(samples.length).fill(null);
      Object.keys(fixedLabels).forEach(function (key) {
        labels[parseInt(key, 10)] = fixedLabels[key];
      });
      freeIndices.forEach(function (idx, j) { labels[idx] = freeLabels[j]; });

      if (previousLabels && labels.every(function (v, i) { return v === previousLabels[i]; })) {
        break;
      }
      previousLabels = labels.slice();

      COLOR_LETTERS.forEach(function (letter) {
        var matched = [];
        var weights = [];
        for (var i = 0; i < samples.length; i++) {
          if (labels[i] === letter) {
            matched.push(samples[i]);
            weights.push(1.0);
          }
        }
        if (letter in knownCenters) {
          matched.push(knownCenters[letter]);
          weights.push(4.0);
        }
        if (matched.length) {
          refs[letter] = weightedHsvMean(matched, weights);
        }
      });
    }

    return { labels: labels, references: refs };
  }

  function lettersToKociembaString(stickerLetters) {
    return stickerLetters.map(function (letter) { return LETTER_TO_FACE_CHAR[letter]; }).join("");
  }

  var CubusAlgo = {
    FACE_ORDER: FACE_ORDER,
    CENTER_LETTER_FOR_FACE: CENTER_LETTER_FOR_FACE,
    TOP_COLOR_FOR_FACE: TOP_COLOR_FOR_FACE,
    COLOR_LETTERS: COLOR_LETTERS,
    DEFAULT_HSV: DEFAULT_HSV,
    SWATCH_RGB: SWATCH_RGB,
    LETTER_TO_FACE_CHAR: LETTER_TO_FACE_CHAR,
    GRID_SIZE: GRID_SIZE,
    MAX_SAMPLES_PER_COLOR: MAX_SAMPLES_PER_COLOR,
    hueDistance: hueDistance,
    hsvDistance: hsvDistance,
    assignWithQuota: assignWithQuota,
    weightedHsvMean: weightedHsvMean,
    unmirrorFace: unmirrorFace,
    solveFaceColors: solveFaceColors,
    lettersToKociembaString: lettersToKociembaString
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CubusAlgo;
  } else {
    root.CubusAlgo = CubusAlgo;
  }
})(typeof window !== "undefined" ? window : this);
