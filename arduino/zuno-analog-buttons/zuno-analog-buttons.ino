// Zuno – Analog-Buttons: real buttons next to the changing table that log an entry
// into Zuno – Baby Tracker without anyone picking up a phone.
//
// Board: Arduino Nano ESP32 (any ESP32 with Wi-Fi works with other pin
// names). Written for the Arduino ESP32 core (2.x / 3.x). Nothing to install
// beyond the board package: Wi-Fi, HTTPS and AES-GCM come with the core.
//
// How it works (the whole thing is in README.md next to this file):
//   - A press is sealed ON THE DEVICE with the key from the device code
//     (AES-256-GCM; the same bytes src/crypto.js opens on the phone). The
//     server stores the sealed press and never learns what was pressed;
//     the next phone of the family that syncs makes the entry.
//   - The device learns the time from Zuno's own server (the Date header of
//     a HEAD request) — no time server, no third party anywhere. A press
//     made before the clock is known waits and keeps its true time.
//   - Presses queue while the Wi-Fi is down and go out once it is back.
//
// Configure the five values below, flash, press.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <mbedtls/gcm.h>
#include <sys/time.h>
#include <time.h>
#include <esp_system.h>
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#else
#include <esp_system.h>
#endif
#include "root_ca.h"

// ---------------------------------------------------------------------------
// Configure — in YOUR copy of this sketch (File › New Sketch in the IDE,
// paste this file in), never in the repository's file: the values below
// are your Wi-Fi password and your device code.
// ---------------------------------------------------------------------------

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-wifi-password";

// Where Zuno runs, without a trailing slash (the address you open on the phone).
const char* ZUNO_URL = "https://example.ch/baby";

// The code from Mehr › Einstellungen › Analog-Buttons (96 hex characters; spaces are fine).
const char* ZUNO_CODE = "";

// The buttons: a pin, and the entry a press makes. Wire each button between
// the pin and GND (the internal pull-up does the rest). `details` is the
// entry's details as Zuno stores them — for a diaper: {"kind":"pee"} (Pipi),
// {"kind":"poop"} (Gaggi) or {"kind":"both"} (Beides). Three are laid out;
// a pin without a button reads as "not pressed" (the pull-up), so the lines
// may stay while only two buttons are wired. Any other entry type works the
// same way (README.md).
struct Button {
  uint8_t pin;
  const char* type;
  const char* details;
};
Button BUTTONS[] = {
  { D2, "diaper", "{\"kind\":\"pee\"}" },   // Pipi
  { D3, "diaper", "{\"kind\":\"poop\"}" },  // Gaggi
  { D4, "diaper", "{\"kind\":\"both\"}" },  // Beides
};

// Set to false to skip the certificate check (only while debugging a host
// whose root is not in root_ca.h: the token could then be read on the way).
const bool VERIFY_TLS = true;

// ---------------------------------------------------------------------------
// Nothing below needs changing
// ---------------------------------------------------------------------------

const int BUTTON_COUNT = sizeof(BUTTONS) / sizeof(BUTTONS[0]);
const unsigned long DEBOUNCE_MS = 40;
const unsigned long CLOCK_RESYNC_MS = 6UL * 3600UL * 1000UL;  // the crystal drifts seconds a day; six hours is plenty
const unsigned long WIFI_RETRY_MS = 15000;
const int QUEUE_SIZE = 16;
const size_t BUCKET_SMALL = 128;  // src/crypto.js DEVICE_BUCKETS: every press the same length on the wire
const size_t BUCKET_LARGE = 256;

// The LEDs: the Nano ESP32's RGB LED (LED_RED / LED_GREEN / LED_BLUE are
// constants of its board package, active LOW). Another board gets its one
// built-in LED for everything.
#ifdef ARDUINO_NANO_ESP32
const uint8_t PIN_LED_R = LED_RED;
const uint8_t PIN_LED_G = LED_GREEN;
const uint8_t PIN_LED_B = LED_BLUE;
const bool LED_ACTIVE_LOW = true;
#else
const uint8_t PIN_LED_R = LED_BUILTIN;
const uint8_t PIN_LED_G = LED_BUILTIN;
const uint8_t PIN_LED_B = LED_BUILTIN;
const bool LED_ACTIVE_LOW = false;
#endif

struct Press {
  uint8_t button;
  unsigned long pressedMs;  // millis() at the press: the instant is derived from the clock at send time
};
Press queue[QUEUE_SIZE];
int queueHead = 0, queueCount = 0;

char token[33];      // the first 32 characters of the code
uint8_t key[32];     // the other 64, as bytes
bool codeOk = false;

bool clockSynced = false;
unsigned long clockSyncedAt = 0;
unsigned long nextClockTry = 0;
unsigned long nextSendAt = 0;
unsigned long sendBackoff = 0;
unsigned long lastWifiTry = 0;

bool lastLevel[8];
unsigned long levelSince[8];
unsigned long pressesSinceBoot = 0;

// --- small helpers -----------------------------------------------------------

void led(int pin, bool on) {
  digitalWrite(pin, (on != LED_ACTIVE_LOW) ? HIGH : LOW);
}

void blink(int pin, int times, int ms = 120) {
  for (int i = 0; i < times; i++) {
    led(pin, true);
    delay(ms);
    led(pin, false);
    if (i + 1 < times) delay(ms);
  }
}

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/** The code → the token (kept as text) and the key (bytes); spaces ignored. */
bool parseCode(const char* code) {
  char compact[97];
  int n = 0;
  for (const char* p = code; *p; p++) {
    if (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') continue;
    if (n >= 96 || hexVal(*p) < 0) return false;
    compact[n++] = (char)tolower(*p);
  }
  if (n != 96) return false;
  compact[96] = 0;
  memcpy(token, compact, 32);
  token[32] = 0;
  for (int i = 0; i < 32; i++) {
    key[i] = (uint8_t)((hexVal(compact[32 + i * 2]) << 4) | hexVal(compact[33 + i * 2]));
  }
  return true;
}

/** base64url without padding (RFC 4648 §5), as the app encodes blobs. */
String base64url(const uint8_t* data, size_t len) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  String out;
  out.reserve((len * 4) / 3 + 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)data[i] << 16;
    if (i + 1 < len) v |= (uint32_t)data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out += T[(v >> 18) & 63];
    out += T[(v >> 12) & 63];
    if (i + 1 < len) out += T[(v >> 6) & 63];
    if (i + 2 < len) out += T[v & 63];
  }
  return out;
}

// --- the clock: from Zuno's own server -----------------------------------------

/** "Thu, 16 Oct 2026 10:11:12 GMT" → seconds since 1970 (0 when unreadable). */
time_t parseHttpDate(const String& date) {
  char mon[4];
  int d, y, H, M, S;
  // Skip the weekday ("Thu, "), then "16 Oct 2026 10:11:12 GMT".
  int comma = date.indexOf(',');
  if (comma < 0) return 0;
  if (sscanf(date.c_str() + comma + 1, " %d %3s %d %d:%d:%d", &d, mon, &y, &H, &M, &S) != 6) return 0;
  static const char* months = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char* at = strstr(months, mon);
  if (!at) return 0;
  int m = (at - months) / 3 + 1;
  // Days from civil (proleptic Gregorian), Howard Hinnant's algorithm.
  y -= m <= 2;
  int era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = (long)era * 146097 + (long)doe - 719468;
  return (time_t)days * 86400 + H * 3600 + M * 60 + S;
}

/**
 * HEAD on Zuno's address and read its Date header. Without a certificate
 * check on purpose: the clock is not known yet, and a certificate cannot be
 * judged without one — nothing secret travels in this request. Every press
 * afterwards is verified against root_ca.h.
 */
bool syncClock() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, String(ZUNO_URL) + "/")) return false;
  const char* keys[] = { "Date" };
  http.collectHeaders(keys, 1);
  int code = http.sendRequest("HEAD");
  String date = http.header("Date");
  http.end();
  if (code <= 0 || date.length() == 0) {
    Serial.printf("[clock] no Date header (%d)\n", code);
    return false;
  }
  time_t now = parseHttpDate(date);
  if (now < 1600000000) {
    Serial.printf("[clock] unreadable Date: %s\n", date.c_str());
    return false;
  }
  struct timeval tv = { .tv_sec = now, .tv_usec = 0 };
  settimeofday(&tv, nullptr);
  clockSynced = true;
  clockSyncedAt = millis();
  Serial.printf("[clock] %s\n", date.c_str());
  return true;
}

// --- sealing and sending -----------------------------------------------------------

/** The press's instant: the synced clock, minus how long ago the button was pressed. */
void pressTimeIso(unsigned long pressedMs, char* out, size_t outLen) {
  time_t at = time(nullptr) - (time_t)((millis() - pressedMs) / 1000UL);
  struct tm tm;
  gmtime_r(&at, &tm);
  strftime(out, outLen, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/**
 * Seal one press: the JSON {v:3, at, type, details}, padded with spaces to
 * 128 (or 256) bytes, AES-256-GCM under the key with AAD "bt1|device" and a
 * random 12-byte IV → base64url(0x03 ‖ iv ‖ ciphertext ‖ tag).
 */
bool sealPress(const Press& p, String& blobOut) {
  char at[24];
  pressTimeIso(p.pressedMs, at, sizeof(at));
  char json[200];
  int n = snprintf(json, sizeof(json), "{\"v\":3,\"at\":\"%s\",\"type\":\"%s\",\"details\":%s}", at, BUTTONS[p.button].type, BUTTONS[p.button].details);
  if (n <= 0 || n >= (int)sizeof(json)) return false;
  size_t bucket = n <= (int)BUCKET_SMALL ? BUCKET_SMALL : BUCKET_LARGE;
  if (n > (int)bucket) return false;

  uint8_t padded[BUCKET_LARGE];
  memset(padded, 0x20, bucket);
  memcpy(padded, json, n);

  uint8_t out[1 + 12 + BUCKET_LARGE + 16];
  out[0] = 0x03;
  uint8_t* iv = out + 1;
  esp_fill_random(iv, 12);
  uint8_t* ct = out + 13;
  uint8_t* tag = ct + bucket;
  static const char* aad = "bt1|device";

  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (rc == 0) {
    rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, bucket, iv, 12, (const uint8_t*)aad, strlen(aad), padded, ct, 16, tag);
  }
  mbedtls_gcm_free(&gcm);
  if (rc != 0) {
    Serial.printf("[seal] mbedtls error %d\n", rc);
    return false;
  }
  blobOut = base64url(out, 1 + 12 + bucket + 16);
  return true;
}

/**
 * POST the sealed press. Returns 1 when the server has it, 0 to try again
 * later (no network, a 5xx, a 429), -1 when it will never be taken (a wrong
 * code, a removed device, a bad body: logged, dropped).
 */
int sendPress(const Press& p) {
  String blob;
  if (!sealPress(p, blob)) return -1;
  String body = String("{\"token\":\"") + token + "\",\"blob\":\"" + blob + "\"}";

  WiFiClientSecure client;
  if (VERIFY_TLS) client.setCACert(ROOT_CA);
  else client.setInsecure();
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(client, String(ZUNO_URL) + "/api/devices/events")) return 0;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String answer = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  Serial.printf("[send] %d %s\n", code, answer.c_str());
  if (code == 201) return 1;
  if (code == 429 || code >= 500 || code <= 0) return 0;
  return -1;  // 400 bad body, 404 unknown or removed device, 507 the family's presses are not being read
}

void flushQueue() {
  if (queueCount == 0 || !clockSynced || WiFi.status() != WL_CONNECTED) return;
  if ((long)(millis() - nextSendAt) < 0) return;
  led(PIN_LED_B, true);
  int res = sendPress(queue[queueHead]);
  led(PIN_LED_B, false);
  if (res == 0) {
    // Back off: 5 s, 15 s, 45 s … up to five minutes, then keep trying.
    sendBackoff = sendBackoff == 0 ? 5000 : min(sendBackoff * 3, 300000UL);
    nextSendAt = millis() + sendBackoff;
    blink(PIN_LED_R, 1);
    led(PIN_LED_R, true);
    return;
  }
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  queueCount--;
  sendBackoff = 0;
  nextSendAt = 0;
  if (res == 1) blink(PIN_LED_G, 1);
  else blink(PIN_LED_R, 3);
  led(PIN_LED_R, queueCount > 0);  // "not sent yet" stays on until the queue is empty
}

void enqueue(uint8_t button) {
  if (queueCount == QUEUE_SIZE) {
    // The oldest goes: a queue this full means the device has been offline
    // for a long time, and sixteen presses are a day of diapers.
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
  }
  queue[(queueHead + queueCount) % QUEUE_SIZE] = { button, millis() };
  queueCount++;
  pressesSinceBoot++;
  Serial.printf("[press] button %d (%s %s), %d waiting\n", button + 1, BUTTONS[button].type, BUTTONS[button].details, queueCount);
  blink(PIN_LED_G, 1, 60);
  if (!clockSynced || WiFi.status() != WL_CONNECTED) led(PIN_LED_R, true);  // "not sent yet" until the queue drains
  nextSendAt = 0;
}

// --- buttons and Wi-Fi ---------------------------------------------------------------

void readButtons() {
  unsigned long now = millis();
  for (int i = 0; i < BUTTON_COUNT && i < 8; i++) {
    bool pressed = digitalRead(BUTTONS[i].pin) == LOW;
    if (pressed != lastLevel[i]) {
      lastLevel[i] = pressed;
      levelSince[i] = now;
      Serial.printf("[btn] Knopf %d %s\n", i + 1, pressed ? "gedrückt" : "losgelassen");  // every edge, bounces included
    } else if (pressed && levelSince[i] != 0 && now - levelSince[i] >= DEBOUNCE_MS) {
      levelSince[i] = 0;  // one press per push: counted once it has held for the debounce time
      enqueue(i);
    }
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiTry != 0 && millis() - lastWifiTry < WIFI_RETRY_MS) return;
  lastWifiTry = millis();
  Serial.println("[wifi] connecting …");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  led(PIN_LED_G, false);
  led(PIN_LED_R, false);
  led(PIN_LED_B, false);
  for (int i = 0; i < BUTTON_COUNT && i < 8; i++) {
    pinMode(BUTTONS[i].pin, INPUT_PULLUP);
    lastLevel[i] = false;
    levelSince[i] = 0;
  }
  codeOk = parseCode(ZUNO_CODE);
  if (!codeOk) {
    Serial.println("[setup] ZUNO_CODE is not a device code (96 hex characters from Mehr › Einstellungen › Analog-Buttons)");
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  ensureWifi();
}

/** Why the chip last started: a power-on, the RST button, or a crash — the one thing to know when presses stop. */
const char* resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "Strom eingeschaltet";
    case ESP_RST_EXT: return "RST gedrückt";
    case ESP_RST_SW: return "Software-Neustart";
    case ESP_RST_PANIC: return "ABSTURZ (panic)";
    case ESP_RST_INT_WDT: return "ABSTURZ (interrupt watchdog)";
    case ESP_RST_TASK_WDT: return "ABSTURZ (task watchdog)";
    case ESP_RST_WDT: return "ABSTURZ (watchdog)";
    case ESP_RST_DEEPSLEEP: return "aus dem Tiefschlaf";
    case ESP_RST_BROWNOUT: return "BROWNOUT (Spannung eingebrochen)";
    case ESP_RST_SDIO: return "SDIO";
    default: return "unbekannt";
  }
}

/** What a freshly opened serial monitor sees (USB drops what was printed before it connected). */
void greet() {
  Serial.printf("[boot] Zuno Analog-Buttons · %d Knöpfe · Code %s · WLAN %s · Uhr %s · %d wartend\n",
                BUTTON_COUNT, codeOk ? "ok" : "FEHLT/ungültig", WiFi.status() == WL_CONNECTED ? "verbunden" : "nicht verbunden",
                clockSynced ? "gestellt" : "nicht gestellt", queueCount);
  Serial.printf("[boot] läuft seit %lu s · letzter Start: %s · %lu Drücke seit dem Start\n",
                millis() / 1000UL, resetReasonText(), pressesSinceBoot);
  for (int i = 0; i < BUTTON_COUNT; i++) {
    Serial.printf("[boot] Knopf %d: Pin %d, %s %s, liest gerade %s\n", i + 1, BUTTONS[i].pin, BUTTONS[i].type, BUTTONS[i].details,
                  digitalRead(BUTTONS[i].pin) == LOW ? "GEDRÜCKT" : "offen");
  }
}

void loop() {
  static bool greeted = false;
  if (Serial && !greeted) {
    greeted = true;
    greet();
  } else if (!Serial) {
    greeted = false;  // the monitor was closed: greet again when it comes back
  }
  readButtons();
  if (!codeOk) {
    // Nothing can be sent: say so with the red LED and keep reading the buttons (the presses wait).
    led(PIN_LED_R, (millis() / 500) % 2 == 0);
    delay(5);
    return;
  }
  ensureWifi();
  if (WiFi.status() == WL_CONNECTED) {
    bool due = !clockSynced || millis() - clockSyncedAt > CLOCK_RESYNC_MS;
    if (due && (long)(millis() - nextClockTry) >= 0) {
      if (!syncClock()) nextClockTry = millis() + 60000;  // try again in a minute, buttons keep working meanwhile
    }
    if (clockSynced) flushQueue();
  }
  delay(5);
}
