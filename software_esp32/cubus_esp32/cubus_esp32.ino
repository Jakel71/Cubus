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
const char *AP_PASSWORD = "012345678"; // must be 8+ chars

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 12000;
const char *CALIBRATION_PATH = "/calibration.json";
const char *MDNS_NAME = "cubus"; // reachable at http://cubus.local

// ---------------------------------------------------------------------
// Arduino link (turns the solved move list into physical cube turns)
// ---------------------------------------------------------------------
// The ESP32-C3 relays the solve, one move at a time, to an Arduino over a
// second UART (NOT the USB/Serial Monitor one) - the Arduino is the thing
// actually driving motors to turn the cube. Wire ESP32 TX -> Arduino RX,
// ESP32 RX -> Arduino TX, and a common GND. Pick GPIOs that are free on
// your specific board (avoid strapping pins like GPIO2/8/9 on most C3
// boards); 4 and 5 are usually safe on a bare ESP32-C3 dev module.
const int ARDUINO_RX_PIN = 20; // ESP32 pin that receives from Arduino TX
const int ARDUINO_TX_PIN = 21; // ESP32 pin that sends to Arduino RX
const unsigned long ARDUINO_BAUD = 9600;

// Protocol is deliberately dead simple, one line each way:
//   ESP32 -> Arduino: the move text, e.g. "R2\n", "F'\n", "U\n"
//   Arduino -> ESP32: "OK\n" once that move has physically finished, or
//                      "ERR <reason>\n" if it can't execute it (e.g. a jam)
// The ESP32 waits for that reply before sending the next move, so moves
// can never outrun however long a physical turn actually takes.
const unsigned long ARDUINO_ACK_TIMEOUT_MS = 15000;
const int MAX_SOLUTION_MOVES = 64; // generous headroom over typical ~20-30 move solves

HardwareSerial ArduinoSerial(1);

enum SolutionState { SOLUTION_IDLE, SOLUTION_RUNNING, SOLUTION_DONE, SOLUTION_ERROR };

String solutionMoves[MAX_SOLUTION_MOVES];
int solutionMoveCount = 0;
int solutionCurrentIndex = -1;
SolutionState solutionState = SOLUTION_IDLE;
String solutionError = "";
unsigned long solutionAckDeadline = 0;
String arduinoLineBuffer = "";


// Lower TX power = less current draw = less heat, and often more stable
// on marginal 5V supplies/USB cables (the C3's radio can spike ~300+mA at
// full power, which brownouts a lot of "5V 1A" chargers and cheap cables -
// that instability/heat combo is usually a power-supply symptom, not a
// software bug). Full power is WIFI_POWER_19_5dBm; this cuts it down a
// lot while still giving plenty of range for a phone/laptop on the same
// LAN. Raise it (toward WIFI_POWER_19_5dBm) if you need more range and
// have solid power; lower it further (WIFI_POWER_8_5dBm, WIFI_POWER_7dBm)
// if it's still hot/unstable.
const wifi_power_t WIFI_TX_POWER = WIFI_POWER_5dBm;


WebServer server(80);

// ---------------------------------------------------------------------
// WiFi
// ---------------------------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_TX_POWER);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    // Some cores reset TX power on connect - reassert it.
    WiFi.setTxPower(WIFI_TX_POWER);
    Serial.print("Connected. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi join failed - starting fallback access point.");
    WiFi.mode(WIFI_AP);
    WiFi.setTxPower(WIFI_TX_POWER);
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
// Solution relay - parses "R U2 F' ..." and feeds it to the Arduino
// ---------------------------------------------------------------------
String jsonEscape(const String &s) {
  String out;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out;
}

// A move is one face letter (U D L R F B) optionally followed by ' or 2.
bool isValidMove(const String &move) {
  if (move.length() < 1 || move.length() > 2) return false;
  char face = move[0];
  if (face != 'U' && face != 'D' && face != 'L' && face != 'R' && face != 'F' && face != 'B') return false;
  if (move.length() == 2 && move[1] != '\'' && move[1] != '2') return false;
  return true;
}

// Splits on whitespace into solutionMoves[]. Returns "" on success, or an
// error message (and leaves the queue untouched) if the text is empty, has
// too many moves, or contains something that isn't a legal move token.
String parseSolutionText(const String &text) {
  String tokens[MAX_SOLUTION_MOVES];
  int count = 0;
  int start = 0;
  int len = text.length();

  while (start < len) {
    while (start < len && isspace(text[start])) start++;
    if (start >= len) break;
    int end = start;
    while (end < len && !isspace(text[end])) end++;
    String token = text.substring(start, end);
    if (count >= MAX_SOLUTION_MOVES) {
      return "solution has more than " + String(MAX_SOLUTION_MOVES) + " moves";
    }
    if (!isValidMove(token)) {
      return "not a legal move: \"" + token + "\"";
    }
    tokens[count++] = token;
    start = end;
  }

  if (count == 0) return "solution is empty";

  for (int i = 0; i < count; i++) solutionMoves[i] = tokens[i];
  solutionMoveCount = count;
  return "";
}

void sendNextMove() {
  solutionCurrentIndex++;
  if (solutionCurrentIndex >= solutionMoveCount) {
    solutionState = SOLUTION_DONE;
    Serial.println("Solution complete.");
    return;
  }
  const String &move = solutionMoves[solutionCurrentIndex];
  ArduinoSerial.print(move);
  ArduinoSerial.print('\n');
  Serial.printf("-> Arduino move %d/%d: %s\n", solutionCurrentIndex + 1, solutionMoveCount, move.c_str());
  solutionState = SOLUTION_RUNNING;
  solutionAckDeadline = millis() + ARDUINO_ACK_TIMEOUT_MS;
}

void startSolution() {
  solutionCurrentIndex = -1;
  solutionError = "";
  sendNextMove();
}

// Non-blocking: call every loop() iteration. Reads whatever the Arduino has
// sent a line at a time, and advances/aborts the queue accordingly, without
// ever stalling server.handleClient().
void pollArduino() {
  while (ArduinoSerial.available()) {
    char c = ArduinoSerial.read();
    if (c == '\n') {
      arduinoLineBuffer.trim();
      if (arduinoLineBuffer.length() && solutionState == SOLUTION_RUNNING) {
        if (arduinoLineBuffer == "OK") {
          sendNextMove();
        } else if (arduinoLineBuffer.startsWith("ERR")) {
          solutionState = SOLUTION_ERROR;
          solutionError = arduinoLineBuffer.length() > 4 ? arduinoLineBuffer.substring(4) : "Arduino reported an error";
          Serial.println("Arduino error: " + solutionError);
        }
        // Anything else (e.g. debug prints from the Arduino) is ignored.
      }
      arduinoLineBuffer = "";
    } else if (c != '\r') {
      arduinoLineBuffer += c;
    }
  }

  if (solutionState == SOLUTION_RUNNING && millis() > solutionAckDeadline) {
    solutionState = SOLUTION_ERROR;
    solutionError = "timed out waiting for the Arduino to finish move " +
      String(solutionCurrentIndex + 1) + " (\"" + solutionMoves[solutionCurrentIndex] + "\")";
    Serial.println("Arduino timeout: " + solutionError);
  }
}

// ---------------------------------------------------------------------
// Solution API
// ---------------------------------------------------------------------
void handlePostSolution() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing body\"}");
    return;
  }
  if (solutionState == SOLUTION_RUNNING) {
    server.send(409, "application/json", "{\"ok\":false,\"error\":\"a solution is already running\"}");
    return;
  }

  String err = parseSolutionText(server.arg("plain"));
  if (err.length()) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"" + jsonEscape(err) + "\"}");
    return;
  }

  server.send(200, "application/json", "{\"ok\":true,\"moveCount\":" + String(solutionMoveCount) + "}");
  startSolution(); // send the first move after responding, not before
}

void handleGetSolutionStatus() {
  String state;
  switch (solutionState) {
    case SOLUTION_IDLE: state = "idle"; break;
    case SOLUTION_RUNNING: state = "running"; break;
    case SOLUTION_DONE: state = "done"; break;
    case SOLUTION_ERROR: state = "error"; break;
  }
  String currentMove = (solutionCurrentIndex >= 0 && solutionCurrentIndex < solutionMoveCount)
    ? solutionMoves[solutionCurrentIndex] : "";

  String json = "{";
  json += "\"state\":\"" + state + "\",";
  json += "\"currentIndex\":" + String(solutionCurrentIndex) + ",";
  json += "\"moveCount\":" + String(solutionMoveCount) + ",";
  json += "\"currentMove\":\"" + jsonEscape(currentMove) + "\",";
  json += "\"error\":\"" + jsonEscape(solutionError) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handlePostSolutionCancel() {
  solutionState = SOLUTION_IDLE;
  solutionMoveCount = 0;
  solutionCurrentIndex = -1;
  solutionError = "";
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

  ArduinoSerial.begin(ARDUINO_BAUD, SERIAL_8N1, ARDUINO_RX_PIN, ARDUINO_TX_PIN);
  Serial.printf("Arduino UART started on RX=%d TX=%d @ %lu baud\n", ARDUINO_RX_PIN, ARDUINO_TX_PIN, ARDUINO_BAUD);

  if (MDNS.begin(MDNS_NAME)) {
    Serial.printf("mDNS responder started: http://%s.local\n", MDNS_NAME);
  }

  server.on("/api/calibration", HTTP_GET, handleGetCalibration);
  server.on("/api/calibration", HTTP_POST, handlePostCalibration);
  server.on("/api/calibration/reset", HTTP_POST, handleResetCalibration);
  server.on("/api/solution", HTTP_POST, handlePostSolution);
  server.on("/api/solution/status", HTTP_GET, handleGetSolutionStatus);
  server.on("/api/solution/cancel", HTTP_POST, handlePostSolutionCancel);
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP server started.");
}

void loop() {
  server.handleClient();
  pollArduino();
}
