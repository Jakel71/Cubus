/*
 * Cubus - Arduino move receiver (stub / test version)
 * -----------------------------------------------------------------------
 * Matches the protocol the ESP32 sketch (cubus_esp32.ino) speaks:
 *   ESP32 -> Arduino: one move per line, e.g. "R2\n", "F'\n", "U\n"
 *   Arduino -> ESP32: "OK\n" once that move is "done"
 *
 * This version doesn't drive any motors yet - it just stores whatever
 * move it receives in a variable, waits 10 seconds (stand-in for however
 * long a real physical turn will take), then sends "OK" back. Once your
 * motor control is ready, replace the comment in executeMove() with the
 * real turn logic and call reportDone() (or reportError()) when it
 * actually finishes, instead of the fixed 10s delay.
 *
 * WIRING
 * ------
 * If your board has a second hardware serial (Mega, Leonardo, Due, etc.),
 * use that for the ESP32 link and keep the USB Serial free for debug
 * prints - that's what this sketch assumes (Serial1). On an Uno/Nano,
 * which only has one hardware UART, you have two options:
 *   1. Use Serial (pins 0/1) for the ESP32 link. You lose USB debug
 *      prints while it's wired up, and must disconnect the ESP32's TX
 *      from pin 0 whenever you re-upload the sketch (it fights with the
 *      USB bootloader otherwise).
 *   2. Use the SoftwareSerial library on two spare digital pins instead,
 *      and keep Serial free for USB debug prints. Swap the commented
 *      block below in if you want this.
 */

// ---- Option A (default): dedicated hardware serial, e.g. Mega/Leonardo ----
// #define LinkSerial Serial1

// ---- Option B: SoftwareSerial on an Uno/Nano - comment out the line
// above, uncomment these three, and wire ESP32 TX->pin 10, ESP32 RX->pin 11 ----
#include <SoftwareSerial.h>
SoftwareSerial LinkSerial(10, 11); // RX, TX
// (Serial stays free for USB debug prints in this option.)

const unsigned long LINK_BAUD = 9600; // must match ARDUINO_BAUD in cubus_esp32.ino
const unsigned long MOVE_DURATION_MS = 10000; // placeholder "turn takes this long"

enum State { WAITING_FOR_MOVE, EXECUTING_MOVE };

State state = WAITING_FOR_MOVE;
String currentMove = "";       // the variable holding the move we last received
String incomingLine = "";      // scratch buffer while a line is arriving
unsigned long moveStartedAt = 0;

void setup() {
  Serial.begin(115200);        // USB debug console
  LinkSerial.begin(LINK_BAUD); // link to the ESP32
  Serial.println("Cubus Arduino stub ready, waiting for moves...");
}

void loop() {
  readIncomingMove();

  if (state == EXECUTING_MOVE && millis() - moveStartedAt >= MOVE_DURATION_MS) {
    reportDone();
  }
}

// Reads whatever is available a line at a time. When a full line arrives
// and we're not already busy with a move, stores it in currentMove and
// starts "executing" it.
void readIncomingMove() {
  while (LinkSerial.available()) {
    char c = LinkSerial.read();

    if (c == '\n') {
      incomingLine.trim();
      if (incomingLine.length() > 0) {
        if (state == WAITING_FOR_MOVE) {
          currentMove = incomingLine;
          executeMove(currentMove);
        } else {
          // A move arrived while we were still "executing" the last one -
          // shouldn't happen since the ESP32 waits for our OK, but ignore
          // it defensively rather than losing track of state.
          Serial.println("Ignoring move, still busy: " + incomingLine);
        }
      }
      incomingLine = "";
    } else if (c != '\r') {
      incomingLine += c;
    }
  }
}

// Placeholder "turn the cube" step. Replace the body with real motor
// control; for now it just remembers the move and starts a 10s timer.
void executeMove(const String &move) {
  Serial.println("Executing move: " + move);
  state = EXECUTING_MOVE;
  moveStartedAt = millis();
}

void reportDone() {
  Serial.println("Move done: " + currentMove);
  LinkSerial.print("OK\n");
  state = WAITING_FOR_MOVE;
}

// Call this instead of reportDone() if a move physically fails (e.g. a
// jam) once you have real motor feedback to detect that.
void reportError(const String &reason) {
  Serial.println("Move failed: " + currentMove + " (" + reason + ")");
  LinkSerial.print("ERR " + reason + "\n");
  state = WAITING_FOR_MOVE;
}
