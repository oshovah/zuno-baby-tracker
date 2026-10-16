# Zuno – Taster: real buttons for the changing table

A small Wi-Fi microcontroller with push buttons that logs a diaper (or
anything else) into Zuno with one press — no phone needed. The sketch in
`zuno-taster/` is written for the **Arduino Nano ESP32**; any ESP32 board
with Wi-Fi works with other pin names.

End-to-end encryption holds: the press is sealed **on the device** with a
key the server never sees. The server stores a blob it cannot read, and the
next phone of the family that syncs turns it into the entry — signed with
the device's name.

## What you need

- An Arduino Nano ESP32 (or another ESP32 with Wi-Fi) and a USB cable
- One push button per entry (momentary, normally open), wired between a
  pin and GND — the sketch uses the internal pull-ups, no resistors
- The Arduino IDE 2.x with the board package **Arduino ESP32 Boards**
  (Boards Manager; the Espressif *esp32* package works too)
- A device code from the app: Mehr › Einstellungen › Taster › «Taster
  hinzufügen» (the code is also shown again later by tapping the device)

## Wiring

| Button | Pin | Entry |
| --- | --- | --- |
| 1 | D2 ↔ GND | Windel · Pipi |
| 2 | D3 ↔ GND | Windel · Gaggi |

A third button for «Beides» is one more line in `BUTTONS[]`
(`{"kind":"both"}`). Any event type Zuno knows works the same way — the
`details` are what the app stores for that type (see `src/validate.js`):
a bottle `{"amount_ml":90}`, a medication `{"name":"Vitamin D"}`, a sleep
timer `{}` (a second sleep press while one runs is refused by the phone).

## Setup

1. Open `zuno-taster/zuno-taster.ino` in the Arduino IDE, select the
   board and its port.
2. Fill in the block at the top: Wi-Fi name and password, `ZUNO_URL` (the
   address you open on the phone, without a trailing slash) and
   `ZUNO_CODE` (paste from the app; spaces are fine).
3. Upload. Open the serial monitor at 115200 baud to watch it connect,
   read the time and send.

The device is now registered in the app; press a button and the entry
appears on both phones with the next sync (within a minute while the app
is open). «Testdruck senden» in the app sends one press without the
hardware — the same bytes the sketch sends — to prove the path.

## The LEDs (Nano ESP32)

| LED | Meaning |
| --- | --- |
| green blink | a press was taken, or a press was sent |
| blue | sending |
| red on | presses are waiting (no Wi-Fi, no clock yet) |
| red blink ×1 | a send failed, will be retried (backing off up to five minutes) |
| red blink ×3 | the server refused the press for good — see the serial monitor |
| red flashing | `ZUNO_CODE` is not a device code |

## How it works

- **The code** = the token (32 hex) followed by the key (64 hex). The
  server knows the token only as a hash and checks it on every press; the
  key never leaves the device and the family's phones.
- **A press** is `{"v":3,"at":"<UTC>","type":"diaper","details":{…}}`,
  padded with spaces to 128 bytes (so a «Pipi» and a «Gaggi» are the same
  length on the wire), encrypted with AES-256-GCM (hardware-accelerated on
  the ESP32; AAD `bt1|device`, a random 12-byte IV) and posted as
  base64url(`0x03` ‖ iv ‖ ciphertext ‖ tag) to `POST /api/devices/events`
  together with the token — no cookie, no account.
- **The time** comes from Zuno's own server: a `HEAD` on `ZUNO_URL` and its
  `Date` header, at boot and every six hours. No time server, no third
  party. A press made before the clock is known keeps its true time (the
  device remembers how long ago it was pressed). A phone refuses a press
  whose time is in the future or older than a week.
- **TLS**: presses are verified against `root_ca.h` (ISRG Root X1, the
  root behind Let's Encrypt). Another certificate authority: paste its
  root there. The clock request alone runs without the check — a
  certificate cannot be judged before the clock is known, and that request
  carries nothing.
- **Offline**: up to 16 presses wait in memory while the Wi-Fi is down and
  go out in order once it is back; a reboot loses what is waiting.
- **Limits** (the server's): 60 presses an hour per address, 200 unread
  presses per family — a stuck button stops there. A `404` means the
  device was removed in the app; a `429`, the hourly budget.

## Security notes

Whoever has the code can make entries for the family (not read them: the
code opens nothing the server stores). Keep the sketch with the code to
yourself; remove the device in the app if the board is lost — its token
stops working at once. The Wi-Fi password is in the sketch too.
