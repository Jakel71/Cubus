/*
 * Cubus vision helpers: RGB -> HSV conversion (OpenCV convention, H in [0,180))
 * and a small k-means implementation used to find the dominant color inside
 * a sticker patch, replacing cv2.kmeans() from the Python scanner.
 */
(function (root) {
  "use strict";

  function rgbToHsvOpenCV(r, g, b) {
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var delta = max - min;

    var h;
    if (delta === 0) {
      h = 0;
    } else if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0) h += 360;

    var s = max === 0 ? 0 : (delta / max) * 255;
    var v = max;

    return [h / 2.0, s, v]; // OpenCV scales H to [0,180)
  }

  // pixels: array of [r,g,b]. Returns {labels, centers, sizes}
  function kmeansRGB(pixels, k, maxIter) {
    var n = pixels.length;
    if (n === 0) return null;
    if (n <= k) {
      // trivial: every point its own cluster
      var centers0 = pixels.map(function (p) { return p.slice(); });
      var labels0 = pixels.map(function (_, i) { return i; });
      var sizes0 = pixels.map(function () { return 1; });
      return { labels: labels0, centers: centers0, sizes: sizes0 };
    }

    function distSq(a, b) {
      var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
      return dr * dr + dg * dg + db * db;
    }

    function initCentersPP() {
      var centers = [];
      centers.push(pixels[Math.floor(Math.random() * n)].slice());
      while (centers.length < k) {
        var dists = pixels.map(function (p) {
          var best = Infinity;
          for (var c = 0; c < centers.length; c++) {
            var d = distSq(p, centers[c]);
            if (d < best) best = d;
          }
          return best;
        });
        var total = dists.reduce(function (a, b) { return a + b; }, 0);
        if (total <= 0) {
          centers.push(pixels[Math.floor(Math.random() * n)].slice());
          continue;
        }
        var r = Math.random() * total;
        var acc = 0;
        for (var i = 0; i < n; i++) {
          acc += dists[i];
          if (acc >= r) {
            centers.push(pixels[i].slice());
            break;
          }
        }
      }
      return centers;
    }

    function runOnce() {
      var centers = initCentersPP();
      var labels = new Array(n).fill(0);

      for (var iter = 0; iter < maxIter; iter++) {
        var changed = false;
        for (var i = 0; i < n; i++) {
          var best = 0, bestDist = Infinity;
          for (var c = 0; c < k; c++) {
            var d = distSq(pixels[i], centers[c]);
            if (d < bestDist) { bestDist = d; best = c; }
          }
          if (labels[i] !== best) { labels[i] = best; changed = true; }
        }

        var sums = [];
        var counts = [];
        for (var c2 = 0; c2 < k; c2++) { sums.push([0, 0, 0]); counts.push(0); }
        for (var j = 0; j < n; j++) {
          var lbl = labels[j];
          sums[lbl][0] += pixels[j][0];
          sums[lbl][1] += pixels[j][1];
          sums[lbl][2] += pixels[j][2];
          counts[lbl] += 1;
        }
        for (var c3 = 0; c3 < k; c3++) {
          if (counts[c3] > 0) {
            centers[c3] = [sums[c3][0] / counts[c3], sums[c3][1] / counts[c3], sums[c3][2] / counts[c3]];
          }
        }

        if (!changed && iter > 0) break;
      }

      var inertia = 0;
      for (var m = 0; m < n; m++) inertia += distSq(pixels[m], centers[labels[m]]);

      var sizes = new Array(k).fill(0);
      labels.forEach(function (l) { sizes[l] += 1; });

      return { labels: labels, centers: centers, sizes: sizes, inertia: inertia };
    }

    var best = runOnce();
    var second = runOnce();
    if (second.inertia < best.inertia) best = second;

    return best;
  }

  // Mirrors dominant_bgr_cluster() + the HSV-averaging part of read_sticker_hsv()
  // from cube_scanner.py. pixelsRGB: array of [r,g,b] (0-255).
  function dominantClusterHsv(pixelsRGB) {
    if (!pixelsRGB.length) return [0, 0, 0];

    var result = kmeansRGB(pixelsRGB, 3, 12);
    if (!result) return [0, 0, 0];

    var brightness = result.centers.map(function (c) { return c[0] + c[1] + c[2]; });
    var eligible = [];
    for (var i = 0; i < brightness.length; i++) {
      if (brightness[i] < 720) eligible.push(i);
    }
    if (eligible.length === 0) {
      for (var i2 = 0; i2 < result.centers.length; i2++) eligible.push(i2);
    }

    var largest = eligible[0];
    for (var e = 1; e < eligible.length; e++) {
      if (result.sizes[eligible[e]] > result.sizes[largest]) largest = eligible[e];
    }

    var dominantPixels = [];
    for (var p = 0; p < pixelsRGB.length; p++) {
      if (result.labels[p] === largest) dominantPixels.push(pixelsRGB[p]);
    }

    var hsvPixels = dominantPixels.map(function (px) { return rgbToHsvOpenCV(px[0], px[1], px[2]); });

    var sumCos = 0, sumSin = 0, sumW = 0;
    var sats = [], vals = [];
    hsvPixels.forEach(function (hsv) {
      var hueRad = hsv[0] * (Math.PI / 90.0);
      var w = hsv[1] + 1.0;
      sumCos += Math.cos(hueRad) * w;
      sumSin += Math.sin(hueRad) * w;
      sumW += w;
      sats.push(hsv[1]);
      vals.push(hsv[2]);
    });

    var meanAngle = Math.atan2(sumSin / sumW, sumCos / sumW);
    if (meanAngle < 0) meanAngle += 2 * Math.PI;
    var meanHue = meanAngle * (90.0 / Math.PI);

    function median(arr) {
      var sorted = arr.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
    }

    return [meanHue, median(sats), median(vals)];
  }

  var CubusVision = {
    rgbToHsvOpenCV: rgbToHsvOpenCV,
    kmeansRGB: kmeansRGB,
    dominantClusterHsv: dominantClusterHsv
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CubusVision;
  } else {
    root.CubusVision = CubusVision;
  }
})(typeof window !== "undefined" ? window : this);
