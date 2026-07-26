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
esp32/cubus_esp32.ino   Arduino sketch (WiFi, web server, calibration API,
                         solution relay to a second Arduino over UART)
data/index.html         Page layout + styling
data/app.js             Camera capture, capture/edit workflow, UI wiring,
                         sends the solved move list to the ESP32 and shows
                         live turn-by-turn progress
data/algorithm.js       Ported 1:1 from cube_scanner.py: hue/HSV distance,
                         assign_with_quota, weighted_hsv_mean,
                         solve_face_colors, unmirror_face
data/vision.js          RGB->HSV (OpenCV convention) + a small k-means
                         implementation, replacing cv2.kmeans()
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
6. Once solved, tap **Send to Cubus robot** to hand the move list to the
   ESP32, which relays it to the Arduino driving the physical cube turns.
   The page polls progress and shows "Move 7/24: R2" style updates as each
   turn completes.

## Sending the solve to a robot (ESP32 -> Arduino)

The browser does the scanning and solving; the ESP32 is just a relay
between the browser and a second microcontroller (the Arduino) that
actually turns the cube. This only matters if you're building the
physical solver — skip this section if you're just using Cubus to get the
move list yourself.

**Wiring**: a second UART, separate from the ESP32's USB/Serial Monitor
connection. Connect ESP32 TX (`ARDUINO_TX_PIN`, default GPIO5) to the
Arduino's RX, ESP32 RX (`ARDUINO_RX_PIN`, default GPIO4) to the Arduino's
TX, and tie the grounds together. Pick different GPIOs in the sketch if
those two are already in use on your board (avoid strapping pins like
GPIO2/8/9 on most ESP32-C3 boards).

**Protocol**: deliberately minimal, one line at a time, `9600` baud by
default (`ARDUINO_BAUD` in the sketch):
- ESP32 → Arduino: the move text plus a newline, e.g. `R2\n`, `F'\n`, `U\n`
- Arduino → ESP32: `OK\n` once that move has physically finished, or
  `ERR <reason>\n` if it can't do it (e.g. a jam)

The ESP32 waits for that reply before sending the next move — moves can
never outrun however long a physical turn actually takes on your rig. If
no reply arrives within `ARDUINO_ACK_TIMEOUT_MS` (15s by default), the
ESP32 gives up on the solve and reports a timeout back to the browser.
Your Arduino sketch just needs to: read a line, execute that turn, then
print `OK` (or `ERR ...`) when done.

**HTTP endpoints** (used by `app.js`, but usable directly for testing,
e.g. with `curl`):
- `POST /api/solution` — body is the raw move string (`"R U2 F' D2 ..."`,
  same format `cube.js`'s `solve()` returns). Starts relaying to the
  Arduino; responds `{"ok":true,"moveCount":N}` or a 400/409 with an
  error if the text is invalid or a solve is already running.
- `GET /api/solution/status` — `{"state":"idle"|"running"|"done"|"error",
  "currentIndex":N,"moveCount":N,"currentMove":"R2","error":"..."}`
- `POST /api/solution/cancel` — resets the relay to idle (does not stop
  a turn already in progress on the Arduino itself).

## Troubleshooting

**"CORS request blocked" / `file:///api/calibration`**
This means the page was opened directly from disk (`file://...`) instead of
through a server. Relative URLs like `/api/calibration` only make sense
when the page itself was loaded over `http(s)://`. Always open the app via
the ESP32's address (`http://<esp32-ip>/` or `http://cubus.local/`), or
during local dev via `python3 -m http.server` + `http://localhost:8000`.
`app.js` now detects a non-http origin and skips the network call
entirely (falling back straight to `localStorage`), so this no longer
throws a scary console error even if you do open it as a file.

**Page freezes / tab hangs when you press "Solve cube"**
`cube.js`'s `Cube.fromString()` will build a `Cube` object out of *any*
facelet string, even a physically impossible one (e.g. two stickers
swapped by a mis-scan). It does not validate legality. `cube.solve()` then
has no idea the state is impossible - it runs an IDA* search up to depth
22 looking for a solution that can never exist, which for an illegal cube
means exploring a huge portion of the search space on the main thread.
That's what looked like a freeze. `app.js` now checks permutation/parity
legality (matching corner and edge permutation parity, valid orientation
sums) right after building the `Cube` object and *before* calling
`.solve()`. If the scan is illegal, you get an immediate, specific error
("scan has X wrong") pointing you to Undo + Edit instead of a hung tab.
Note this only catches *physically impossible* scans - a valid-but-wrong
scan (e.g. one sticker mislabeled as a color that still forms a legal
permutation) will solve "successfully" but for the wrong cube, so it's
still worth double-checking each face with Edit if the result looks off.

**Camera doesn't start, no error shown**
Almost certainly the secure-origin issue from the section above. On an
insecure origin (plain `http://<esp32-ip>`, which is exactly how the
ESP32 serves this page unless you've set up the Chrome flag or HTTPS
workaround), browsers don't just reject the camera request - they don't
expose `navigator.mediaDevices` at all, so calling `.getUserMedia` on it
threw a silent, uncatchable error and nothing visibly happened. `app.js`
now checks for this explicitly before touching the camera and shows a
clear on-page message with the fix (the Chrome flag, or HTTPS) instead of
failing silently. If you still see nothing after updating, bump the
`?v=` cache-buster on `app.js` in `index.html` (already done here) and
hard-refresh, since browsers hold onto these files aggressively.

## Known limitations vs. the Python version

- k-means clustering runs in JavaScript on whatever device opens the page,
  so it's throttled to update roughly every 220ms rather than every video
  frame — plenty for a mostly-static cube face, but noticeably less smooth
  than OpenCV on a desktop.
- No `--list-cameras` equivalent; browsers expose camera selection as
  "front/rear" via `facingMode`, not device indices.
- See the HTTPS note above — this is the main practical hurdle to sort out
  for your specific network/devices.
