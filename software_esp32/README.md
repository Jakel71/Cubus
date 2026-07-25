# Cubus — ESP32-C3 web version

A port of `cube_scanner.py` to a self-contained web app served by an
ESP32-C3. Point your phone or laptop's browser at the ESP32's IP address,
scan all six faces of the cube with the device's own camera, and get a
solve from Herbert Kociemba's two-phase algorithm — all running locally in
the browser.

## Why the architecture changed

The ESP32-C3 has no camera interface (that's only on the original ESP32 /
S2 / S3), and it's far too limited in RAM/CPU to run OpenCV-style k-means
clustering or the Kociemba solver itself. So the split is:

- **ESP32-C3**: WiFi + web server. Serves the page and persists your color
  calibration to flash (`/calibration.json`, the on-device equivalent of
  `cube_calibration.json`).
- **Browser** (phone or laptop, wherever you open the page): camera
  capture, the k-means dominant-color detection, the HSV color-matching
  and assignment algorithm, and the cube solve. All ported from
  `cube_scanner.py`.

## Files

```
esp32/cubus_esp32.ino   Arduino sketch (WiFi, web server, calibration API)
data/index.html         Page layout + styling
data/app.js             Camera capture, capture/edit workflow, UI wiring
data/algorithm.js       Ported 1:1 from cube_scanner.py: hue/HSV distance,
                         assign_with_quota, weighted_hsv_mean,
                         solve_face_colors, unmirror_face
data/vision.js          RGB->HSV (OpenCV convention) + a small k-means
                         implementation, replacing cv2.kmeans
data/cubejs.js           Vendored two-phase solver (npm package "cubejs",
                         MIT licensed) implementing Kociemba's algorithm —
                         same algorithm the Python `kociemba` package uses
```

`algorithm.js` was unit-tested against your real `cube_calibration.json`
and 25 randomly-scrambled cubes with realistic sensor noise added — all 25
matched the true cube state exactly before being handed to the solver.

## Setup

1. **Arduino IDE**: install board support for **esp32 by Espressif Systems**
   (Boards Manager, 2.0.9+), then select **ESP32C3 Dev Module**.
2. Open `esp32/cubus_esp32.ino` and fill in `WIFI_SSID` / `WIFI_PASSWORD`
   near the top.
3. **Upload the `data/` folder to LittleFS.** This is a separate step from
   uploading the sketch:
   - Arduino IDE 2.x: install the **Arduino LittleFS Upload** plugin
     (via the command palette / VS Code-style extension search), put
     `esp32/cubus_esp32.ino`'s sibling `data/` folder next to the sketch,
     and run **"Upload LittleFS to Pico/ESP32"** from the command palette.
   - Alternatively use `arduino-cli` with `mklittlefs`, or the classic
     Arduino ESP32 Sketch Data Upload tool if your IDE version supports it.
4. Upload the sketch itself as normal.
5. Open the Serial Monitor at 115200 baud. It prints either the WiFi IP
   address, or — if the WiFi join fails — a fallback access point
   (`Cubus-Setup` / password `cubuscube`) you can join directly. It also
   starts mDNS, so `http://cubus.local` usually works too.

## ⚠️ Important: camera access needs a "secure origin"

Browsers only allow camera access (`getUserMedia`) on HTTPS pages, or on
`localhost`. The ESP32 serves plain HTTP over your LAN, which most mobile
browsers will treat as insecure and **block camera access** by default.

Workarounds, roughly in order of convenience:

- **Android Chrome / desktop Chrome**: visit
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://<esp32-ip-or-cubus.local>` to the list, enable the flag, and
  relaunch Chrome. This is the easiest path for testing.
- **iOS Safari has no equivalent flag** and will not grant camera access
  over plain HTTP. On iOS you'd need to serve the page over HTTPS — for
  example by putting a reverse proxy (e.g. Caddy or nginx with a
  self-signed/mkcert certificate) on a computer on the same network in
  front of the ESP32, or by adding TLS support directly on the ESP32
  (`WiFiClientSecure`-based server) — this is real added complexity and
  isn't included here.
- For quick development, running `data/` from a local dev server on
  `localhost` (any static file server) sidesteps the issue entirely, since
  `localhost` is always considered secure.

## Local testing without the ESP32

You can serve the `data/` folder directly from any machine, since
everything except calibration persistence works purely client-side (it
falls back to `localStorage` automatically if `/api/calibration` isn't
reachable):

```
cd data
python3 -m http.server 8000
```

Then open `http://localhost:8000` — camera access works out of the box
here since `localhost` is a secure origin.

## Using it

1. Open the page, allow camera access, pick rear/front camera as needed.
2. Hold the cube so the current face fills the 3×3 grid overlay, matching
   the header prompt (which center color and which color should face up,
   same as the Python version's `TOP_COLOR_FOR_FACE` prompts).
3. Tap **Calibrate center** once per face if colors look off (this is the
   same purpose as pressing `c` in the Python tool) — samples persist to
   the ESP32's flash.
4. Tap **Capture face** when the grid looks right. You'll get an
   Edit / Continue prompt, same as the Python tool's "press E to edit".
5. Repeat for all 6 faces (in U, R, F, D, L, B order), then tap
   **Solve cube**.

## Known limitations vs. the Python version

- k-means clustering runs in JavaScript on whatever device opens the page,
  so it's throttled to update roughly every 220ms rather than every video
  frame — plenty for a mostly-static cube face, but noticeably less smooth
  than OpenCV on a desktop.
- No `--list-cameras` equivalent; browsers expose camera selection as
  "front/rear" via `facingMode`, not device indices.
- See the HTTPS note above — this is the main practical hurdle to sort out
  for your specific network/devices.
