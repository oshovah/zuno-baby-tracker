# Zuno – Analog-Buttons: real buttons for the changing table

A small Wi-Fi microcontroller with push buttons that logs a diaper (or
anything else) into Zuno with one press — no phone needed. The sketch in
`zuno-analog-buttons/` is written for the **Arduino Nano ESP32**; any ESP32 board
with Wi-Fi works with other pin names.

End-to-end encryption holds: the press is sealed **on the device** with a
key the server never sees. The server stores a blob it cannot read, and the
next phone of the family that syncs turns it into the entry — signed with
the device's name.

## Bauanleitung (Deutsch) – Schritt für Schritt

Für genau diese Teile: ein **Arduino Nano ESP32** mit angelöteten
Stiftleisten (Pins nach unten) und **6 × 6 mm Taster mit vier Beinen**
(die kleinen schwarzen Knöpfe). Dazu braucht es ein Steckbrett
(Breadboard, halbe Grösse reicht), ein paar Steckbrücken (Jumper-Kabel,
Stecker–Stecker) und ein USB-C-Kabel. Zwei Knöpfe genügen; der dritte
kommt später an denselben Platz.

**Vorher:** Den Nano aus dem schwarzen Schaumstoff nehmen. Der
antistatische Schaum ist leitfähig und verbindet alle Pins miteinander –
nie damit an den Strom.

### 1. Der Knopf: welche Beine?

Ein 6 × 6-Taster hat vier Beine, je zwei davon sind innen fest
verbunden; gedrückt verbindet er die beiden Paare. Welche zwei Beine ein
Paar sind, sieht man dem Knopf nicht an. Die sichere Regel: **immer zwei
diagonal gegenüberliegende Beine** benutzen – die liegen nie im selben
Paar, egal wie der Knopf gedreht ist.

```
   Knopf von oben, vier Beine:

     1 ─┬────────┬─ 2
        │   ( )  │
     3 ─┴────────┴─ 4

   Benutzt werden 1 und 4 (oder 2 und 3) – diagonal.
```

### 2. Der Nano auf dem Steckbrett

Der Nano steckt über dem Mittelgraben des Steckbretts; der USB-C-Stecker
ragt über den Rand hinaus. Die Pin-Reihe mit **D2, D3, D4 und GND** (die
Reihe mit RST / RX0 / TX1 am Ende) kommt in die Reihe **e** – so bleiben
vor jedem dieser Pins vier freie Löcher (a–d). Die andere Reihe (D13,
3.3V, A0 … VIN) landet dann in Reihe **i**.

Die Pins der oberen Reihe, von links (USB) nach rechts:

```
 D12 D11 D10 D9 D8 D7 D6 D5 D4 D3 D2 GND RST RX0 TX1
                            ─┘ ─┘ ─┘  └─ hier wird alles angeschlossen
```

GND ist der Pin **direkt neben D2** (auf der Platine mit einem eckigen
Lötauge). Ein zweites GND liegt am anderen Ende der unteren Reihe neben
VIN – geht genauso.

### 3. Verkabelung

Jeder Knopf sitzt wie der Nano über dem Mittelgraben: zwei Beine in Reihe
e, zwei in Reihe f, zwei Spalten auseinander. Dann:

| Kabel | von | nach | wofür |
| --- | --- | --- | --- |
| 1 | ein Loch vor **GND** (Spalte von GND, Reihe a–d) | blaue Minus-Schiene (–) des Steckbretts | gemeinsame Masse |
| 2 | Knopf 1, Bein in Reihe e (Loch a derselben Spalte) | Minus-Schiene (–) | Knopf 1 an Masse |
| 3 | Knopf 1, **diagonales** Bein in Reihe f (Loch j derselben Spalte) | ein Loch vor **D2** (Reihe a–d) | Knopf 1 = Pipi |
| 4 | Knopf 2, Bein in Reihe e (Loch a) | Minus-Schiene (–) | Knopf 2 an Masse |
| 5 | Knopf 2, diagonales Bein in Reihe f (Loch j) | ein Loch vor **D3** | Knopf 2 = Gaggi |
| 6 | Knopf 3, Bein in Reihe e (Loch a) | Minus-Schiene (–) | später: Knopf 3 an Masse |
| 7 | Knopf 3, diagonales Bein in Reihe f (Loch j) | ein Loch vor **D4** | später: Knopf 3 = Beides |

Mehr ist es nicht: kein Widerstand, keine Diode, kein Strom für die
Knöpfe. Der Nano zieht die Pins intern hoch (Pull-up); ein gedrückter
Knopf zieht den Pin auf Masse, das ist das Signal. Ein Pin ohne Knopf
bleibt oben und löst nie aus – darum dürfen die Zeilen für drei Knöpfe im
Programm stehen, auch wenn erst zwei verkabelt sind.

Als Bild (halbes Steckbrett, Spalten 1–30; der Nano links über dem
Graben, die Knöpfe rechts; `●` = Bein, `═` = Kabel):

```
  Spalte:   …  9  10  11  12 … 20  22     24  26     28  30
  Reihe a      ·   ·   ·   ·     ●═══╗      ●═══╗      ●═══╗     } Knopf-Bein → –
  Reihe b      ·   ·   ·   ·     ·   ║      ·   ║      ·   ║
  Reihe c      ·   ·   ·   ·     ·   ║      ·   ║      ·   ║
  Reihe d      ·   ·  ═╗  ·      ·   ║      ·   ║      ·   ║
  Reihe e     D4  D3  D2 GND     ●   ●      ●   ●      ●   ●     ← Nano-Pins / Knopf-Beine
  ───────── Mittelgraben ─────────────────────────────────────────
  Reihe f      ·   ·   ·   ·     ●   ●      ●   ●      ●   ●
  Reihe g      ·   ·   ·   ·     ·   ·      ·   ·      ·   ·
  Reihe h      ·   ·   ·   ·     ·   ·      ·   ·      ·   ·
  Reihe i     A?  A?  A?  A?     ·   ·      ·   ·      ·   ·     ← Nano-Pins (untere Reihe)
  Reihe j      ·   ·   ·   ·     ·   ●═══   ·   ●═══   ·   ●═══  } diagonales Bein → D2 / D3 / D4
  Minus (–)  ═══════════════════╝════════════╝═══════════╝        ← alle Massen, dazu Kabel 1 von GND
```

(Die Kabel von Reihe j zu D2 / D3 / D4 laufen oben über den Nano hinweg –
ein Stecker vor D2, einer vor D3, einer vor D4.) Die Spaltenzahlen sind
Beispiele; wichtig ist nur: ein Knopf über dem Graben, ein Bein an Minus,
das diagonale Bein an den Pin.

**Ohne Steckbrett** geht es auch: an zwei diagonale Beine jedes Knopfs je
ein Kabel löten; die Masse-Kabel aller Knöpfe zusammen auf eine Buchse
(Dupont, Buchse–Buchse) an den GND-Pin, die anderen Kabel einzeln auf
D2, D3, D4. Die Stiftleisten des Nano nehmen solche Buchsen direkt auf.

### 4. Der Code

Der ganze Code ist die Datei `zuno-analog-buttons/zuno-analog-buttons.ino`
(mit `root_ca.h` daneben, beide gehören zusammen). Anzupassen ist nur der
Block oben:

```cpp
const char* WIFI_SSID = "your-wifi";             // euer WLAN
const char* WIFI_PASS = "your-wifi-password";
const char* ZUNO_URL  = "https://example.ch/baby";  // die Adresse von Zuno, ohne Schrägstrich am Ende
const char* ZUNO_CODE = "";                      // der Code aus Mehr › Einstellungen › Analog-Buttons

Button BUTTONS[] = {
  { D2, "diaper", "{\"kind\":\"pee\"}" },   // Knopf 1: Pipi
  { D3, "diaper", "{\"kind\":\"poop\"}" },  // Knopf 2: Gaggi
  { D4, "diaper", "{\"kind\":\"both\"}" },  // Knopf 3: Beides (Pin darf noch leer sein)
};
```

So kommt er auf den Nano:

1. Arduino IDE 2 installieren. Unter **Tools › Board › Boards Manager**
   «Arduino ESP32 Boards» installieren.
2. In der App: Mehr › Einstellungen › Analog-Buttons › «Analog-Buttons
   hinzufügen», dem Gerät einen Namen geben («Wickeltisch»), «Code
   kopieren».
3. Die Datei `zuno-analog-buttons.ino` öffnen, die vier Werte eintragen
   (den Code zwischen die Anführungszeichen; Leerzeichen stören nicht).
4. Den Nano per USB-C anschliessen, **Tools › Board › Arduino ESP32
   Boards › Arduino Nano ESP32** wählen, unter **Tools › Port** den Nano,
   dann **Upload** (der Pfeil). Nimmt der Nano den Upload nicht an:
   RST-Knopf auf der Platine zweimal kurz drücken (die LED pulsiert, der
   Nano wartet auf Firmware) und nochmals hochladen.
5. **Tools › Serial Monitor**, 115200 Baud: Dort steht «[wifi] connecting»,
   «[clock] …» (die Uhrzeit vom Server) und bei jedem Druck «[press] …»
   und «[send] 201 {"ok":true}».

### 5. Ausprobieren

Knopf 1 drücken: die grüne LED blinkt einmal (Druck erfasst), kurz blau
(wird gesendet), grün (angekommen). Innerhalb einer Minute steht «Windel ·
Pipi» mit dem Namen des Geräts im Verlauf beider Handys – die App muss
dafür offen sein, sie holt die Drücke beim Abgleich. Rot an heisst: es
warten Drücke (kein WLAN oder noch keine Uhrzeit); dreimal rot heisst:
der Server lehnt ab, der Serial Monitor sagt warum (404 = Gerät in der
App entfernt, 400 = Code falsch eingetragen).

## What you need

- An Arduino Nano ESP32 (or another ESP32 with Wi-Fi) and a USB cable
- Up to three push buttons (momentary, normally open), each wired between
  a pin and GND — the sketch uses the internal pull-ups, no resistors. Two
  are enough to start: a pin without a button simply never fires
- The Arduino IDE 2.x with the board package **Arduino ESP32 Boards**
  (Boards Manager; the Espressif *esp32* package works too)
- A device code from the app: Mehr › Einstellungen › Analog-Buttons ›
  «Analog-Buttons hinzufügen» (the code is also shown again later by tapping the device)

## Wiring

| Button | Pin | Entry |
| --- | --- | --- |
| 1 | D2 ↔ GND | Windel · Pipi |
| 2 | D3 ↔ GND | Windel · Gaggi |
| 3 | D4 ↔ GND | Windel · Beides (optional — leave the pin open until you add the button) |

Pins and entries live in `BUTTONS[]` at the top of the sketch; swap a pin
or a kind there. Any event type Zuno knows works the same way — the
`details` are what the app stores for that type (see `src/validate.js`):
a bottle `{"amount_ml":90}`, a medication `{"name":"Vitamin D"}`, a sleep
timer `{}` (a second sleep press while one runs is refused by the phone).

## Setup

1. Open `zuno-analog-buttons/zuno-analog-buttons.ino` in the Arduino IDE, select the
   board and its port.
2. Fill in the block at the top: Wi-Fi name and password, `ZUNO_URL` (the
   address you open on the phone, without a trailing slash) and
   `ZUNO_CODE` (paste from the app; spaces are fine).
3. Upload. Open the serial monitor at 115200 baud to watch it connect,
   read the time and send.

The device is now registered in the app (one device per board, however
many buttons it has — the app names the device, the sketch says which
button logs what); press a button and the entry appears on both phones
with the next sync (within a minute while the app
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
