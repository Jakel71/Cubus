/*
 * Cubus - ESP32-C3 web server
 * -----------------------------------------------------------------------
 * Serves the Cubus cube-scanner web app (index.html / app.js / vision.js /
 * algorithm.js / cubejs.js) from LittleFS, and persists the color
 * calibration samples to /calibration.json on flash - the on-device
 * equivalent of cube_calibration.json from the Python version.
 *
 * All camera capture, color detection and cube solving happens in the
 * browser (on whatever phone/laptop opens this page). The ESP32-C3 only
 * hosts the page and stores calibration data - it does not have a camera
 * interface of its own.
 *
 * SETUP
 * -----
 * 1. Board: "ESP32C3 Dev Module" (install via Boards Manager: esp32 by
 *    Espressif Systems, version 2.0.9+).
 * 2. Fill in WIFI_SSID / WIFI_PASSWORD below.
 * 3. Upload the contents of the sibling "data" folder to LittleFS.
 *    Easiest options:
 *      - Arduino IDE 2.x: install the "Arduino LittleFS Upload" plugin,
 *        then run "LittleFS Upload" from the command palette.
 *      - Or use `arduino-cli` / `mklittlefs` manually.
 *    The data folder must contain: index.html, app.js, algorithm.js,
 *    vision.js, cubejs.js
 * 4. Upload this sketch normally.
 * 5. Open the Serial Monitor at 115200 baud to see the assigned IP
 *    address (or connect to the fallback AP if WiFi join fails), then
 *    browse to it from your phone or laptop.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <ESPmDNS.h>

// ---- Fill these in ----
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Fallback access point, used if the WiFi join above fails
const char *AP_SSID = "Cubus-Setup";
const char *AP_PASSWORD = "cubuscube"; // must be 8+ chars

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 12000;
const char *CALIBRATION_PATH = "/calibration.json";
const char *MDNS_NAME = "cubus"; // reachable at http://cubus.local

WebServer server(80);

// ---------------------------------------------------------------------
// WiFi
// ---------------------------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi join failed - starting fallback access point.");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    Serial.print("AP SSID: ");
    Serial.println(AP_SSID);
    Serial.print("AP password: ");
    Serial.println(AP_PASSWORD);
    Serial.print("AP IP address: ");
    Serial.println(WiFi.softAPIP());
  }
}

// ---------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------
String contentTypeFor(const String &path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "text/plain";
}

bool serveFile(String path) {
  if (path.endsWith("/")) path += "index.html";
  if (!LittleFS.exists(path)) return false;

  File f = LittleFS.open(path, "r");
  if (!f) return false;
  server.streamFile(f, contentTypeFor(path));
  f.close();
  return true;
}

void handleNotFound() {
  if (serveFile(server.uri())) return;
  server.send(404, "text/plain", "Not found: " + server.uri());
}

// ---------------------------------------------------------------------
// Calibration API - persists /calibration.json across reboots
// ---------------------------------------------------------------------
void handleGetCalibration() {
  if (!LittleFS.exists(CALIBRATION_PATH)) {
    server.send(200, "application/json", "{}");
    return;
  }
  File f = LittleFS.open(CALIBRATION_PATH, "r");
  if (!f) {
    server.send(200, "application/json", "{}");
    return;
  }
  server.streamFile(f, "application/json");
  f.close();
}

void handlePostCalibration() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing body\"}");
    return;
  }
  const String &body = server.arg("plain");

  File f = LittleFS.open(CALIBRATION_PATH, "w");
  if (!f) {
    server.send(500, "application/json", "{\"ok\":false,\"error\":\"could not open file\"}");
    return;
  }
  f.print(body);
  f.close();

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleResetCalibration() {
  if (LittleFS.exists(CALIBRATION_PATH)) {
    LittleFS.remove(CALIBRATION_PATH);
  }
  server.send(200, "application/json", "{\"ok\":true}");
}

// ---------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nCubus ESP32-C3 starting...");

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed! Did you upload the data folder?");
  } else {
    Serial.println("LittleFS mounted.");
  }

  connectWiFi();

  if (MDNS.begin(MDNS_NAME)) {
    Serial.printf("mDNS responder started: http://%s.local\n", MDNS_NAME);
  }

  server.on("/api/calibration", HTTP_GET, handleGetCalibration);
  server.on("/api/calibration", HTTP_POST, handlePostCalibration);
  server.on("/api/calibration/reset", HTTP_POST, handleResetCalibration);
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP server started.");
}

void loop() {
  server.handleClient();
}
