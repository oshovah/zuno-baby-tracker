# Zuno – Analog-Buttons: real buttons for the changing table

A small Wi-Fi microcontroller with push buttons that logs a diaper (or any
other entry) into Zuno with one press — no phone needed. The sketch in
`zuno-analog-buttons/` is written for the **Arduino Nano ESP32**; any ESP32
board with Wi-Fi works with other pin names.

End-to-end encryption holds all the way: a press is sealed **on the device**
with a key the server never sees. The server stores a blob it cannot read,
and the next phone of the family that syncs turns it into the entry, signed
with the device's name.

This folder has two parts:

- **The sketch** — the firmware, finished and in use.
- **A proof-of-concept build** on a breadboard with a dev board and loose
  tactile buttons: enough to test the whole path end to end, not a thing
  to mount on a changing table. A soldered, installable version with
  proper buttons follows.

## How it works

- **One device = one board.** The app registers a device and names it (the
  name signs every entry the device makes); which physical button logs what
  is set in the sketch. A board may carry up to three buttons — one entry
  each — and a pin without a button simply never fires.
- **The device code** from the app (96 hex characters) is the token (32
  hex) followed by the key (64 hex). The server knows the token only as a
  hash and checks it on every press; the key never leaves the device and
  the family's phones.
- **A press** is `{"v":3,"at":"<UTC>","type":"diaper","details":{…}}`,
  padded with spaces to 128 bytes (so a «Pipi» and a «Gaggi» have the same
  length on the wire), encrypted with AES-256-GCM (hardware-accelerated on
  the ESP32; AAD `bt1|device`, a random 12-byte IV) and posted as
  base64url(`0x03` ‖ iv ‖ ciphertext ‖ tag) to `POST /api/devices/events`
  together with the token — no cookie, no account.
- **The time** comes from Zuno's own server: a `HEAD` on `ZUNO_URL` and its
  `Date` header, at boot and every six hours. No time server, no third
  party. A press made before the clock is known keeps its true time (the
  device remembers how long ago it was pressed). A phone refuses a press
  whose time is in the future or older than a week.
- **TLS:** presses are verified against `root_ca.h` (ISRG Root X1, the root
  behind Let's Encrypt). A host with another certificate authority: paste
  that root there. The clock request alone runs without the check — a
  certificate cannot be judged before the clock is known, and that request
  carries nothing.
- **Offline:** up to 16 presses wait in memory while the Wi-Fi is down and
  go out in order once it is back; a reboot loses what is waiting. The
  network work runs in a task of its own, so the buttons are read all the
  time — two quick presses in a row both arrive.
- **Limits** (the server's): 60 presses an hour per address, 200 unread
  presses per family, 10 devices per family. A `404` means the device was
  removed in the app; a `429`, the hourly budget.

## The sketch

`zuno-analog-buttons/zuno-analog-buttons.ino` and `root_ca.h` belong
together. Only the block at the top is yours to change:

```cpp
const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-wifi-password";
const char* ZUNO_URL  = "https://example.ch/baby";  // the address you open on the phone, no trailing slash
const char* ZUNO_CODE = "";                         // from Mehr › Einstellungen › Analog-Buttons

Button BUTTONS[] = {
  { D2, "diaper", "{\"kind\":\"pee\"}" },   // button 1: Pipi
  { D3, "diaper", "{\"kind\":\"poop\"}" },  // button 2: Gaggi
  { D4, "diaper", "{\"kind\":\"both\"}" },  // button 3: Beides (the pin may stay empty)
};
```

Each button is a pin and the entry a press makes. `details` is what Zuno
stores for that type (see `src/validate.js`): a diaper `{"kind":"pee"}`,
`{"kind":"poop"}` or `{"kind":"both"}`; a bottle `{"amount_ml":90}`; a
medication `{"name":"Vitamin D"}`; a sleep timer `{}` (a second sleep press
while one runs is refused by the phone). Swap a pin or a kind there.

### Getting it onto the board

1. Install the Arduino IDE 2 and, under **Tools › Board › Boards Manager**,
   the package **Arduino ESP32 Boards**.
2. **Make a sketch of your own — do not edit the repository's file.** In the
   IDE: **File › New Sketch**, paste the whole of `zuno-analog-buttons.ino`
   into it, then add a tab named `root_ca.h` (the tab bar's menu, the three
   dots on the right › New Tab) and paste that file in too. The IDE keeps
   your sketch in its own folder; the file in the repository stays clean —
   your Wi-Fi password and your device code must never end up in the
   source.
3. In the app: Mehr › Einstellungen › Analog-Buttons › «Analog-Buttons
   hinzufügen», give the device a name («Wickeltisch»), «Code kopieren».
4. Fill in the four values in your sketch (the code between the quotes;
   spaces are fine).
5. Connect the board over USB-C, choose **Tools › Board › Arduino ESP32
   Boards › Arduino Nano ESP32** and the board under **Tools › Port**, then
   **Upload**.
6. **Tools › Serial Monitor**, 115200 baud. The sketch greets every newly
   connected monitor with a `[boot]` summary (code, Wi-Fi, clock, waiting
   presses, the last reset's reason, every button's pin and current state);
   then `[wifi]`, `[clock] …` (the time from the server) and, on a press,
   `[btn]`, `[press] …` and `[send] 201 {"ok":true}`.

The device is now registered; a press appears on both phones with the next
sync (within a minute while the app is open). «Testdruck senden» in the app
sends one press without the hardware — the same bytes the sketch sends — to
prove the path.

### The LEDs (Nano ESP32)

| LED | Meaning |
| --- | --- |
| green, steady | the board's power LED — always on, not the sketch's |
| green blink | a press was taken, or a press was sent |
| blue | sending |
| red on | presses are waiting (no Wi-Fi, no clock yet) |
| red blink ×1 | a send failed, will be retried (backing off up to five minutes) |
| red blink ×2 | the queue is full (16 waiting), the press was dropped |
| red blink ×3 | the server refused the press for good — see the serial monitor |
| red flashing | `ZUNO_CODE` is not a device code |

## Proof of concept on a breadboard

A test rig, not a product: a dev board pressed into a breadboard, loose
tactile buttons, jumper wires. It proves the whole chain — button, device,
server, phones — in an afternoon. For the changing table a soldered build
with proper buttons follows; the sketch stays the same.

### Parts

- An Arduino Nano ESP32 with male headers soldered (pins pointing down)
- Up to three 6 × 6 mm tactile buttons with four legs (two are enough to
  start)
- A half-size breadboard (30 columns, rows a–j, two power rails) and a
  handful of male–male jumper wires
- A USB-C cable

Before you start: take the Nano out of the black foam it ships in. That
anti-static foam is conductive and ties every pin to every other — never
power the board in it.

### The button's legs

A 6 × 6 tactile button has four legs, two of them joined inside; pressing
connects the two pairs. Which two legs form a pair is not visible. The safe
rule: **always use two diagonally opposite legs** — they are never in the
same pair, whichever way the button is turned.

```
   button from above, four legs:

     1 ─┬────────┬─ 2
        │   ( )  │
     3 ─┴────────┴─ 4

   use 1 and 4 (or 2 and 3) — diagonal
```

The button must straddle the breadboard's centre channel. A breadboard
joins the five holes a–e of a column and, separately, f–j. A button sitting
entirely on one side would have two of its legs joined by the board itself
— and if those are the two the button is meant to connect, it reads as
pressed all the time. Across the channel the board joins nothing the
button does not join itself. These buttons are made for circuit boards:
their leg pitch (6.5 × 4.5 mm) does not quite match the breadboard's
(7.62 × 5.08 mm), so they hold only with slightly spread legs and firm
pressure. Straighten the legs with small pliers if they are kinked, push
the button in until it seats, and check that it does not wobble.

### The Nano on the breadboard

Lay the breadboard with the numbers 1–30 left to right, row a at the
bottom, row j at the top, the channel between e and f. The Nano straddles
the channel with **its USB-C connector hanging over the left edge** (before
column 1):

- The pin row with **D2, D3, D4, GND** (the one ending in RST / RX0 / TX1)
  goes into row **f**, directly above the channel. Four free holes (g–j)
  remain above every pin: that is where the buttons connect.
- The other row (D13, 3V3, A0 … GND, VIN) then lands in row **b**, with one
  free hole (a) below every pin.

So D12 sits in column 1 and the columns count up:

```
 column:  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15
 row f:  D12 D11 D10  D9  D8  D7  D6  D5  D4  D3  D2 GND RST RX0 TX1
 row b:  D13 3V3  B0  A0  A1  A2  A3  A4  A5  A6  A7 VBUS B1 GND VIN
                                           ─┘  ─┘  ─┘ └─ everything connects here
```

GND exists twice, both with a square pad: in the top row between D2 and
RST (column 12) and in the bottom row between B1 and VIN (column **14** —
VIN is the last pin, column 15). The bottom one is the handier for the
minus rail: its free hole a14 sits right next to the rail. Do not mix them
up: a15 is VIN, the power input, and must never touch the minus rail.

### Wiring

Each button straddles the channel like the Nano: two legs in row e, two in
row f, two columns apart — button 1 in columns 20 and 22, button 2 in 24
and 26, button 3 in 28 and 30. From the leg in row e a wire goes down to
the minus rail, from the **diagonal** leg in row f a wire goes up to the
pin:

| Wire | from | to | what for |
| --- | --- | --- | --- |
| 1 | **a14** (below the bottom row's GND, between B1 and VIN) | bottom minus rail (–) | common ground |
| 2 | **a20** (button 1, leg in row e, column 20) | minus rail (–) | button 1 to ground |
| 3 | **j22** (button 1, diagonal leg in row f, column 22) | **j11** (above D2) | button 1 = Pipi |
| 4 | **a24** (button 2, leg in row e) | minus rail (–) | button 2 to ground |
| 5 | **j26** (button 2, diagonal leg in row f) | **j10** (above D3) | button 2 = Gaggi |
| 6 | **a28** (button 3, leg in row e) | minus rail (–) | later: button 3 to ground |
| 7 | **j30** (button 3, diagonal leg in row f) | **j9** (above D4) | later: button 3 = Beides |

That is all: no resistor, no diode, no power for the buttons. The Nano
pulls the pins up internally; a pressed button pulls its pin to ground,
and that is the signal. A pin without a button stays up and never fires,
which is why the three lines may stay in the sketch while only two buttons
are wired. The minus rail is one long strip on a half-size board: any hole
of it will do (on a full-size board the rails are often split in the
middle — a gap in the printed line shows it). The plus rail stays empty.

As a picture (row j at the top, a at the bottom; `●` = a button leg, `[1]` …
`[7]` = the wires of the table, at both ends):

```
 column:    1   2   3   4   5   6   7   8   9  10  11  12  13  14  15    20  22    24  26    28  30
 row j      ·   ·   ·   ·   ·   ·   ·   ·  [7] [5] [3]  ·   ·   ·   ·     ·  [3]    ·  [5]    ·  [7]
 row i      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ·   ·     ·   ·     ·   ·
 row h      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ·   ·     ·   ·     ·   ·
 row g      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ·   ·     ·   ·     ·   ·
 row f     D12 D11 D10  D9  D8  D7  D6  D5  D4  D3  D2 GND RST RX0 TX1    ●   ●     ●   ●     ●   ●
 ─────────────────────────────── channel ───────────────────────────────────────────────────────────
 row e      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ●   ●     ●   ●     ●   ●
 row d      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ·   ·     ·   ·     ·   ·
 row c      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·     ·   ·     ·   ·     ·   ·
 row b     D13 3V3  B0  A0  A1  A2  A3  A4  A5  A6  A7 VBUS B1 GND VIN    ·   ·     ·   ·     ·   ·
 row a      ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·  [1]  ·    [2]  ·    [4]  ·    [6]  ·
 minus (–) ═[1]═══════════════════════════════════════════════════════[2]═══════[4]═══════[6]═══
 ◄ the USB-C connector hangs over this edge
```

Wires 3, 5 and 7 run along row j from the buttons left to D2, D3 and D4;
wires 1, 2, 4 and 6 run down to the minus rail. Nothing crosses the Nano.
The buttons' columns are suggestions; what matters is: a button across the
channel, one leg to minus, the diagonal leg to the pin.

**Without a breadboard** the same works with solder: two short wires on two
diagonal legs of each button; the ground wires of all buttons joined onto
one female jumper (Dupont) on the GND pin, the other wires onto D2, D3, D4.
The Nano's header pins take such jumpers directly.

### Trying it out

Press button 1: the green LED blinks once (press taken), blue for a moment
(sending), green again (confirmed). Within a minute «Windel · Pipi» with
the device's name is in the Verlauf of both phones — the app must be open,
it fetches the presses when it syncs. Red on means presses are waiting
(no Wi-Fi or no clock yet); red ×3 means the server refused, and the serial
monitor says why.

### Troubleshooting

- **"Bad CPU type in executable" … `esptool` … "exit status 126"** (Mac
  with an Apple chip): the board package's `esptool` is an Intel binary
  and Rosetta 2 is missing. Run
  `softwareupdate --install-rosetta --agree-to-license` once in the
  Terminal (it asks for your Mac password), then upload again — nothing
  needs reinstalling. The message is shown under "Compilation error" but
  has nothing to do with the sketch.
- **The Nano does not take the upload** (the port vanishes, "no device
  found"): press RST on the board twice quickly — the LED pulses, the Nano
  waits for firmware — then pick the new entry under Tools › Port and
  upload again.
- **`root_ca.h: No such file`**: the second tab is missing in your sketch
  (step 2 above).
- **It works once, then no more — or only while pressing on the Nano:** the
  Nano is not seated firmly. The USB cable's weight tilts it a little and
  the pins lose contact with the breadboard's springs. Push the Nano in to
  the stop and route the cable so it does not hang on the connector (a
  rubber band or cable tie on the board, a bend in the cable on the table).
- **Nothing blinks, nothing in the serial monitor:** set the monitor to
  115200 baud and press RST on the Nano, or close and reopen the monitor —
  the sketch greets every newly connected monitor with `[boot] …` and one
  line per button («Pin 2, diaper … liest gerade offen»). What was printed
  before the monitor connected is discarded by the USB port. «Code
  FEHLT/ungültig» means `ZUNO_CODE` is wrong. A button reading «GEDRÜCKT»
  with nobody pressing has two legs of the same pair wired — take the
  diagonal leg. No `[press]` on a press: bridge the button — hold a wire
  from j11 (above D2) to the minus rail for a moment. If `[press]` appears
  now, the fault is the button or its legs; if not, the link from j11 to
  D2 or the ground (is the Nano really seated with D2 in column 11?).

## Security notes

Whoever has the device code can make entries for the family (not read
them: the code opens nothing the server stores). Keep your sketch with the
code to yourself; remove the device in the app if the board is lost — its
token stops working at once. The Wi-Fi password is in your sketch too.
