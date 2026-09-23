# Zuno – Baby Tracker

A small, self-hosted newborn tracker for two parents — nursing, bottles,
diapers, sleep, measurements and daily reminders, shared between both phones
and **end-to-end encrypted**: the server stores ciphertext only and never
sees a password.

No e-mail address, no tracking, no third-party requests, no app store. The
client is a vanilla-JS PWA (Vite, zero runtime dependencies), the server a
tiny PHP 7.4+ API over SQLite that runs on cheap shared hosting. The UI ships
in German (Swiss flavour, the source language) and English.

This repository is public so that anyone can check the privacy claims the app
makes. The operator documentation further down is in German; the product spec
([SPEC.md](SPEC.md)) and all code and comments are in English.

## Security model — what the server can and cannot see

Everything that describes the baby is encrypted **on the phone** before it is
sent. The server is an opaque per-family store: it hands rows back and forth
and computes nothing.

| The server stores | The server never gets |
|---|---|
| Usernames and family names in plaintext (needed to log in and to join) | Any password — only a value derived from it (PBKDF2 + HKDF), which is bcrypt-hashed again on the server |
| Per entry ONE opaque blob, a sequence number and day-granular created / updated / deleted dates | What an entry is (feed, diaper, sleep, weight …), its times, amounts, notes or who logged it — all of that is inside the blob |
| The family's data key only *wrapped* (AES-KW) under keys derived from passwords | The family data key itself: it is generated on the phone and only ever leaves it wrapped |
| Display names and family settings as encrypted blobs | |
| SHA-256 hashes of the session tokens (HttpOnly, SameSite cookie) | |
| Throttle counters keyed by the client's address (failed logins, registrations, entry writes) — rows older than a day are pruned at the next login or registration | |

What a server still learns, like any server: that a family exists, how many
rows it has and roughly when a phone writes (request times, web-server logs),
the client's IP address, and which of two size buckets an entry falls into
(plaintext is padded to 256 or 512 bytes so the length does not give the
entry type away).

**How it works** — the full picture is the header of
[`src/crypto.js`](src/crypto.js):

```
password ─PBKDF2-SHA256 (600 000 rounds, 16-byte salt)─▶ master key, discarded at once
  master key ─HKDF─▶ auth key  (sent to the server, bcrypt-hashed there)
  master key ─HKDF─▶ KEK       (AES-KW, never leaves the phone; wraps the family data key)
family data key = 32 random bytes (AES-GCM-256, one per family, encrypts every entry)
  base64url(family data key) = the 43-character recovery code
entry = base64url(0x01 ‖ iv ‖ AES-GCM(key, iv, AAD "bt1|<familyId>|<eid>", padded JSON))
```

On the phone the family data key lives in IndexedDB as a **non-extractable**
WebCrypto key, next to the ciphertext mirror of the family's rows and the
outbox — writes made without network, kept as ciphertext until they are sent.
The family password is a one-time invite: the phone that joins replaces it
with random credentials in the same transaction, so a guessed or passed-on
family password opens nothing afterwards.

**Where to check it**

- [`src/crypto.js`](src/crypto.js) — every primitive, pure WebCrypto, tested by
  [`src/tests/crypto.test.mjs`](src/tests/crypto.test.mjs)
- [`src/session.js`](src/session.js) and [`src/keys.js`](src/keys.js) — the
  register / join / login / recovery flows and where the key is kept
- [`src/store.js`](src/store.js) — the only module that talks to the API: what
  is actually sent
- [`api/lib/db.php`](api/lib/db.php) — the schema: no column for a type, a time
  or an amount, and [`api/index.php`](api/index.php) — the routes: none that
  takes or returns an entry's content
- [`api/lib/auth.php`](api/lib/auth.php) and
  [`api/lib/entries.php`](api/lib/entries.php) — auth values and throttling;
  the opaque row store and family isolation (a foreign entry id answers 404,
  never 403)
- [`scripts/package.mjs`](scripts/package.mjs) — the packaged `.htaccess`: a
  Content-Security-Policy that allows the app's own scripts only, HSTS,
  `nosniff`, `Referrer-Policy: same-origin`

**Limits, said plainly.** End-to-end encryption in a web app protects against
a leaked database or backup, curious hosting staff and an operator who would
like to read along. It does not protect against a compromised phone, and —
as with every web app — whoever controls the server could ship a modified
client that leaks the key. The answers to that are the strict CSP, no
third-party code at runtime, this public source, and that you can host it
yourself. A weak password stays weak: with a stolen database an attacker can
guess passwords offline, slowed only by PBKDF2. And there is no password
reset — lose your password, the recovery code and every logged-in phone, and
the data is gone. That is the price of the server not having a key.

Found a hole? See [SECURITY.md](SECURITY.md).

## Run it yourself

Requirements: Node 20+ and PHP ≥ 7.4 with `pdo_sqlite` on the PATH.

```bash
npm install
npm run dev     # PHP API on :8788 + Vite on :5173 (proxies /api)
npm test        # PHP API tests + node tests of the crypto / model modules
```

There is no default account: open the app and register. To deploy, copy
`.env.example` to `.env`, fill in the `DEPLOY_*` values and run
`npm run package` / `npm run deploy` — any host with PHP and Apache-style
`.htaccess` will do; the details are under «Deployment» below. Contributor
guides: designs in [`src/themes/README.md`](src/themes/README.md), languages
in [`src/i18n/locales/README.md`](src/i18n/locales/README.md).

**Hosting somewhere else? Change the login page.** The pitch under the login
form describes the reference installation: it names its hoster (cyon in
Basel, Switzerland) and says that nothing outside that hosting is involved.
The second half holds for every copy — the app loads no third-party font,
script, image or API, and the packaged CSP (`default-src 'self'`,
`connect-src 'self'`) makes the browser enforce it. The first half is only
true where it is true: if your copy runs elsewhere, change `HOSTER` in
[`src/views/login.js`](src/views/login.js), the `taglineTrust`, `hosting.*`
and `about.*` strings in `src/i18n/locales/*/login.js` and the description in
`index.html` before you put it online. The same page links to the source
(`SOURCE_URL`, next to `HOSTER`): if you run a **modified** copy for other
people, the AGPL asks you to offer them *your* source — point it there.

The pictures in the login page's slider are the real app with invented data,
taken by `npm run screenshots` ([`scripts/make-screenshots.mjs`](scripts/make-screenshots.mjs):
a scratch database, headless Chrome, a week of a newborn written through the
app's own code — needs Chrome, PHP and Node 22+). Re-run it after a change
to one of the screens it shows.

## Private artwork

The repo ships its own icon set. If your family would rather see pictures you
may use at home but not publish, put them into the gitignored `private-art/`
folder under the same names (`favicon.png`, `apple-touch-icon.png`,
`icon-192.png`, `icon-512.png`, `zuno.png`) and name your family in `.env`
(`PRIVATE_ART_FAMILY`). `npm run package` then ships the folder behind a deny
rule, and the API hands the pictures to that family's sessions only
([`api/lib/art.php`](api/lib/art.php), [`src/art.js`](src/art.js)). Everyone
else — logged out or in another family — sees the public icons and gets a 404
on the route. So the code that runs is still exactly the code in this repo;
only a few pictures differ.

The install icon is the one thing a session cannot serve: a browser reads the
web manifest and its icons without the page's cookie, and Android has the icon
downloaded by URL from an install service. For that the family's phones get a
capability link, `GET /api/art/k/<key>/…` — `<key>` is 32 random hex digits
of the installation, handed to that family's sessions only; the link serves the
same files plus a manifest that points at them (same app id). Whoever holds
the link sees the pictures, nobody can guess it, and a wrong key is the same
404. Know what that means before you use it: the install icon leaves your
server, to that service.

Limits: an icon that already sits on an iOS home screen stays what it is
(remove the app and add it again); an installed Android app follows the
manifest by itself after a few days.

## Licence

[GNU Affero General Public License v3.0](LICENSE). In short: use it, host it,
change it — but if you run a modified version for other people, you have to
offer them your source too. For an app whose whole point is that you can check
what it does, that seemed the right rule. The icon set is original work,
drawn by [`scripts/make-icons.mjs`](scripts/make-icons.mjs). The bundled fonts
(Inter, Jost, Nunito) are under the SIL Open Font License, their licence texts
sit next to them in [`src/themes/fonts/`](src/themes/fonts/).

---

# Dokumentation (Deutsch)

Zuno ist ein einfacher, selbst gehosteter Baby-Tracker für zwei Eltern: Stillen,
Schoppen, Windeln, Schlaf, Messwerte und tägliche Erinnerungen (Vitamin D
fürs Baby, ein Medikament für Mama) — synchronisiert über ein PHP-API mit
SQLite auf Shared Hosting (cyon). Produktentscheide stehen in
[SPEC.md](SPEC.md).

- **Frontend:** Vanilla JS + Vite, mobile-first, deutsche UI, installierbar
  als Home-Screen-App (Manifest + Service Worker; die Shell öffnet auch bei
  schlechtem Netz sofort).
- **Backend:** PHP 7.4+ (`api/`), SQLite (WAL). Konten in Familien: Jede
  Person hat ein eigenes Login (Benutzername + Passwort) und einen
  Anzeigenamen (Mama/Papa/…), jede Familie einen Namen und ein
  Familien-Passwort, das nur zum Beitreten dient und mit jedem Beitritt
  verfällt (ein Mitglied setzt zum Einladen ein neues). Einträge gehören der
  Familie — eine Installation kann mehrere Familien beherbergen, die einander
  nie sehen. Sessions als DB-Tokens im 6-Monats-Cookie.
- **Ende-zu-Ende verschlüsselt:** Jeder Eintrag (Art, Zeiten, Mengen, Namen)
  wird auf dem Handy mit einem zufälligen Familienschlüssel verschlüsselt.
  Der Server speichert nur Benutzernamen, Familiennamen, verpackte Schlüssel
  und die verschlüsselten Datensätze — und kann nichts davon lesen. Passwörter
  verlassen das Handy nie (der Server sieht nur einen abgeleiteten Wert).
  Deshalb gibt es kein «Passwort zurücksetzen» durch den Betreiber; siehe
  «Schlüssel und Wiederherstellung».
- **Sync:** Der Server ist die Wahrheit für die verschlüsselten Datensätze;
  jedes Handy hält eine entschlüsselte Kopie im Speicher und berechnet die
  «Jetzt»-Ansicht selbst. Die App synchronisiert im Vordergrund (~60 s) und
  beim Fokuswechsel; laufende Timer liegen in den Datensätzen und lassen sich
  vom anderen Handy stoppen (ein veralteter Stopp wird abgewiesen).
- **Ohne Netz:** Erfassen geht trotzdem — der Eintrag wird verschlüsselt auf
  dem Handy gespeichert («wartet auf Netz»), sofort angezeigt und gesendet,
  sobald Zuno offen ist und wieder Netz hat. Hat das andere Handy denselben
  Eintrag inzwischen beendet, geändert oder gelöscht, gilt dessen Stand, und
  das Handy sagt es. Gesendet wird nur, solange die App offen ist.

## Setup (lokal)

Voraussetzungen: Node 20+ **und PHP ≥ 7.4 mit `pdo_sqlite` im PATH** — der
Dev-Server und `npm test` rufen die `php`-CLI auf. Fehlt PHP, startet Vite
trotzdem und jede API-Anfrage endet als «Keine Verbindung zum Server».

```bash
npm install
npm run dev     # PHP-API auf :8788 + Vite auf :5173 (mit /api-Proxy)
```

Ein Dev-Passwort gibt es nicht: Beim ersten Öffnen «Neues Konto erstellen» —
Benutzername, Passwort (min. 8 Zeichen), Anzeigename, Familie und
Familien-Passwort. Ein unbekannter Familienname legt die Familie an (und zeigt
einmalig den Wiederherstellungscode); bei einem bekannten Namen muss das
Familien-Passwort stimmen, dann tritt das Konto bei — und das Familien-Passwort
verfällt damit (unter «Mehr › Konto» setzt ein Mitglied ein neues, wenn noch
jemand dazukommen soll). Die Datenbank entsteht automatisch unter
`data/baby.db`.

```bash
npm test        # PHP-API-Tests (api/tests/*.test.php) + Node-Tests (src/tests/)
```

Auf einem Handy im LAN läuft `crypto.subtle` nur über HTTPS (`http://192.168…`
ist kein «secure context»): Für den Test auf dem Gerät braucht der Dev-Server
ein Zertifikat (z. B. `@vitejs/plugin-basic-ssl`), oder das Handy greift per
USB-Port-Forwarding auf `localhost` zu.

## Schlüssel und Wiederherstellung

Drei Dinge öffnen die Einträge einer Familie — der Server hat keines davon:

1. **Das eigene Passwort.** Entschlüsselt beim Anmelden den Familienschlüssel
   für dieses Gerät — auch auf einem neuen Handy; das Familien-Passwort
   braucht ein Mitglied dafür nie. Vergessen? Mit einem **neuen
   Benutzernamen** registrieren und wieder beitreten — mit dem
   Wiederherstellungscode oder mit einem Familien-Passwort, das die andere
   Person vorher neu setzt; alle Einträge bleiben erhalten, das alte Konto
   bleibt ungenutzt.
2. **Das Familien-Passwort.** Nur zum Beitreten nötig, und ein
   Einmal-Schlüssel: Mit dem Beitritt ersetzt das beitretende Handy es durch
   Zufallswerte, die niemand kennt (`rotateFamily` in der Registrierung), so
   dass ein erratenes oder weitererzähltes Familien-Passwort nach dem
   Beitritt nichts mehr öffnet. Noch jemand? Jedes angemeldete Mitglied setzt
   unter «Mehr › Konto» ein neues (das eigene Passwort bestätigt) und gibt es
   weiter; wer schon dabei ist, bleibt angemeldet.
3. **Der Wiederherstellungscode.** Der rohe Familienschlüssel (43 Zeichen),
   einmalig beim Anlegen der Familie angezeigt und unter «Mehr › Konto» nach
   Eingabe des eigenen Passworts. Mit ihm legt man ohne jedes Passwort ein neues
   Konto in der Familie an («Mit Wiederherstellungscode» auf dem
   Login-Bildschirm). Aufschreiben.

Gehen alle drei verloren und ist kein Gerät mehr angemeldet, sind die Daten
weg — das ist der Preis der Verschlüsselung. Reserve: **«Daten exportieren»**
unter «Mehr › Konto» schreibt alle Einträge entschlüsselt als JSON-Datei; ab
und zu sicher ablegen.

Offline-Export aus einer Datenbankdatei (z. B. aus einem Backup) mit dem
Wiederherstellungscode oder einem aktuell gesetzten Familien-Passwort (das
alte verfällt mit jedem Beitritt — vorher unter «Mehr › Konto» ein neues
setzen), ohne Server (braucht die
`sqlite3`-Kommandozeile im PATH; bei mehreren Familien `--family <Name>`;
gelöschte Einträge bleiben weg):

```bash
node scripts/export-plain.mjs data/baby.db > export.json
node scripts/export-plain.mjs data/baby.db --recovery-code > export.json
```

Kein Admin-Panel, kein E-Mail: Der Betreiber kann in der Datenbank Konten
löschen, aber keine Passwörter setzen und keine Einträge lesen (siehe
«Konten von Hand verwalten»).

## Deployment (cyon)

Einmalig: `.env.example` nach `.env` kopieren und die `DEPLOY_*`-Zugänge
ausfüllen.

```bash
npm run package   # baut + stellt deploy/ zusammen
npm run preview   # deploy/ lokal testen: http://127.0.0.1:8081 (auch /baby/)
npm run deploy    # deploy/ hochladen (rsync/sftp/ftp gemäss .env)
```

- Re-Deploys fassen das entfernte `data/` **nie** an — die Datenbank auf dem
  Server bleibt bestehen.
- Health-Check: `deploy.mjs` ruft nach dem Upload `<DEPLOY_URL>/api/me` auf.
  Das ist die erste Anfrage nach dem Upload — sie führt eine allfällige
  Datenbank-Migration aus (200 = durch, 500 = zurückgerollt, die Datei ist
  unverändert; der Grund steht im PHP-Fehlerlog). Vor einer Migration
  schreibt die API einmalig eine Kopie neben die Datenbank
  (`baby.db.v3.bak`) — nach ein paar Tagen ohne Probleme löschen.
- Die gepackte `.htaccess` setzt eine Content-Security-Policy (nur eigene
  Skripte): Bei Verschlüsselung im Browser ist eingeschleustes JavaScript der
  letzte verbleibende Angriffsweg. Dazu `nosniff`, `Referrer-Policy:
  same-origin` und HSTS.
- **Datenbank ausserhalb des Docroots** (optional, empfohlen): Standardmässig
  liegt sie unter `<docroot>/data/baby.db`, geschützt durch zwei
  `.htaccess`-Regeln. `DEPLOY_DB_PATH` in `.env` schreibt einen anderen Ort in
  die gepackte `api/config.php`, dann hängt nichts mehr an `.htaccess`:
  absolut, oder relativ zum Docroot mit `../` (z. B. `../baby-data/baby.db`
  — auf Shared Hosting kennt man den absoluten Pfad oft nicht). Reihenfolge
  einhalten — die API legt an einem fehlenden Pfad eine **leere** Datenbank
  an (neue Feed-Kennung, keine Konten: alle Handys wären abgemeldet):
  1. Zu einem ruhigen Zeitpunkt (nachts, kein Timer offen) im Dateimanager
     von my.cyon oder per FTP neben dem Docroot ein Verzeichnis anlegen (z. B.
     `baby-data`, für den Webserver beschreibbar) und `baby.db`, `baby.db-wal`
     und `baby.db-shm` dorthin **verschieben** (nicht kopieren; alle drei).
  2. `DEPLOY_DB_PATH=../baby-data/baby.db` in `.env` setzen, `npm run package`,
     `npm run deploy` — der Health-Check `/api/me` muss 200 liefern, danach
     auf einem Handy einmal synchronisieren.
  3. Das leere `data/` im Docroot kann bleiben (nur der Deny-Stub liegt drin).
  Zurück: Dateien zurückschieben, Variable leeren, erneut deployen.

## Schema v3 → v4

Schema v3 hatte in der Tabelle `entries` noch fünf `legacy_*`-Spalten: Dort
lagen Einträge aus der Zeit vor der Verschlüsselung im Klartext, bis ein Handy
der Familie sie verschlüsselt hatte. v4 entfernt diese Spalten samt dem Code,
der sie las — die API hat seither keine Stelle mehr, die den Inhalt eines
Eintrags annimmt oder ausgibt. Die Migration läuft bei der ersten Anfrage nach
dem Deploy in einer Transaktion; Einträge, Konten, Sitzungen und die
Sync-Stände der Handys bleiben, wie sie sind.

Eine v3-Datei, in der noch ein **lebender** Eintrag im Klartext liegt (oder
einer ohne Familie), wird **abgelehnt** und nicht angefasst: Der Health-Check
meldet 500, der Grund steht im Fehlerlog. Dann den letzten v3-Stand nochmals
deployen, ein Handy der Familie die Einträge fertig verschlüsseln lassen und
erneut deployen. Vorab prüfen lässt es sich auf dem Server (`sqlite3
data/baby.db`) — das Ergebnis muss 0 sein:

```sql
SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL AND (family_id IS NULL
  OR legacy_type IS NOT NULL OR legacy_started_at IS NOT NULL OR legacy_ended_at IS NOT NULL
  OR legacy_details IS NOT NULL OR legacy_logged_by IS NOT NULL);
```

## Konten von Hand verwalten

Direkt in der SQLite-Datei (`sqlite3 data/baby.db`, auf dem Server per SSH).
Passwörter und Einträge lassen sich hier **nicht** lesen oder setzen — die
Hashes gehören zu abgeleiteten Werten, die Datensätze sind verschlüsselt.

```sql
SELECT id, username, family_id, created_at FROM users;
SELECT id, name, name_key, created_at FROM families;     -- name_key = kleingeschriebener Name
SELECT family_id, COUNT(*) FROM entries GROUP BY family_id;
```

Ein Konto entfernen (z. B. ein vergessenes altes nach einer
Wiederherstellung) oder auf allen Geräten abmelden:

```sql
DELETE FROM auth_tokens WHERE user_id = <id>;
DELETE FROM users WHERE id = <id>;
```

Eine ganze Familie löschen (unwiderruflich):

```sql
DELETE FROM entries WHERE family_id = <id>;
DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE family_id = <id>);
DELETE FROM users WHERE family_id = <id>;
DELETE FROM families WHERE id = <id>;
VACUUM;
```

Benutzer lassen sich **nicht** in eine andere Familie verschieben (ihr
verpackter Schlüssel gehört zur alten) — stattdessen neu registrieren und
beitreten.

## API (Kurzreferenz)

Alle Endpunkte unter `/api`, JSON, Fehler als `{"error": "…"}`. `POST`,
`PATCH` und ein `DELETE` mit Body verlangen `Content-Type: application/json`
(415 sonst); jede Antwort ist `Cache-Control: no-store`. Login, Registrierung und alle
Passwort-Bestätigungen sind pro IP gedrosselt (10 Versuche / 15 min → 429) und
zusätzlich pro Ziel — Benutzername bzw. Familienname — von beliebig vielen
Adressen aus (20 / Stunde). Schreibzugriffe auf Einträge sind pro IP auf 300 /
15 min begrenzt (429), und neue Einträge enden bei 50 000 Zeilen pro Familie
bzw. 400 000 insgesamt (507; gelöschte Einträge zählen mit, sie bleiben als
Tombstones) — die Registrierung ist offen, ohne diese Grenzen könnte ein
Fremdkonto die Disk füllen.
Der Client schickt nie ein Passwort, sondern einen daraus abgeleiteten
`authKey` (PBKDF2 + HKDF); Schlüssel und Datensätze sind base64url-Blobs.

| Endpunkt | Auth | Zweck |
|---|---|---|
| `GET /api/me` | – | `{authenticated, user}` — `user` = `{username, familyId, familyName, profileBlob}` (auch Health-Check) |
| `GET /api/auth/params?username=` | – | `{kdf: {salt, iter}}` zum Ableiten des Login-Werts (stabile Attrappe für unbekannte Namen) |
| `GET /api/families/check?name=` | – | `{exists, name, kdf}` — gibt es die Familie schon? |
| `POST /api/families/unlock` | – | `{familyName, familyAuthKey \| recoveryAuthKey}` → `{kdf, fdkWrapped}` (der familien-verpackte Schlüssel, nur nach Prüfung) |
| `POST /api/register` | – | `familyMode: create` (mit allem Schlüsselmaterial) oder `join` (mit `rotateFamily`: neue Familien-Schlüssel, die im selben Schritt das Familien-Passwort ersetzen) → 201 `{ok, user, familyCreated, familyClosed}` + Cookie |
| `POST /api/login` | – | `{username, authKey}` → `{ok, user, kdf, fdkWrappedUser}` + Cookie |
| `POST /api/logout` | – | Token widerrufen |
| `POST /api/me/keys/unlock` | ✓ | `{authKey}` → `{kdf, fdkWrappedUser}` (Gerät ohne Schlüssel) |
| `PATCH /api/me` | ✓ | `{profileBlob}` (verschlüsselter Anzeigename) |
| `PATCH /api/me/password` | ✓ | `{currentAuthKey, authKey, kdf, fdkWrappedUser}` — meldet andere Geräte ab |
| `PATCH /api/families/password` | ✓ | `{currentAuthKey, familyAuthKey, familyKdf, fdkWrappedFamily}` |
| `GET /api/sync?since=&limit=` | ✓ | `{serverNow, feed, rows, next}` — Seiten ab `seq`, inkl. Grabsteine; `reset: true`, wenn der Cursor der Datenbank voraus ist; ändert sich `feed` (eine andere Datenbankdatei), fängt der Client ebenfalls von vorn an |
| `POST /api/entries` | ✓ | `{eid, blob}` → Datensatz (507 an der Zeilengrenze der Familie bzw. der Datenbank) |
| `PATCH /api/entries/:eid` | ✓ | `{blob, ifSeq}` → Datensatz (409, wenn ein anderes Gerät dazwischenkam) |
| `DELETE /api/entries/:eid` | ✓ | Soft-Delete; optionaler JSON-Body `{ifSeq}` macht ihn bedingt (409, wenn ein anderes Gerät dazwischenkam) |
| `POST /api/entries/:eid/restore` | ✓ | Soft-Delete rückgängig |
| `GET /api/art/k/<key>/<name>` | – | Dieselben Bilder und `manifest.webmanifest` über den zufälligen Schlüssel der Installation (nur die Mitglieder jener Familie erhalten ihn, als `artKey` im Sync) — für das, was der Browser ohne Sitzung lädt: das Installations-Symbol. Falscher Schlüssel, unbekannter Name, Funktion aus: dasselbe 404 |
| `GET /api/art/<name>` | (✓) | Privates Bildmaterial (`image/png`) für die Mitglieder der in `PRIVATE_ART_FAMILY` genannten Familie — für alle anderen, auch ohne Anmeldung, dasselbe 404 (siehe «Private artwork») |

Fremde `eid`s → 404. Eintragstypen im Klartext des Blobs: `breastfeed {side,
paused?}`, `bottle {amount_ml, colostrum_ml?}`, `diaper {kind}`, `sleep`, `weight {grams}`,
`temperature {celsius}`, `medication {name}`, `task {title, who,
reminderEid?, due?}` (ein abgehakter Punkt) sowie die Nicht-Ereignisse
`settings` (das Einstellungsdokument der Familie) und `reminder {title, who,
note?, times}` (ein täglicher Zeitplan); Zeiten UTC-ISO; höchstens ein
offener Timer pro Typ und Familie (Regel im Client, bei einem Wettlauf gewinnt
der zuerst gespeicherte).

## Erinnerungen

Unter «Mehr › Erinnerungen» legt die Familie an, was täglich zu festen
Zeiten dran ist — «Vitamin D · 2 Tropfen · 08:00» fürs Baby, «Ibuprofen 600 ·
08:00 · 20:00» für Mama. Ein Zeitplan ist ein verschlüsselter Eintrag wie
jeder andere (Typ `reminder`), also auf beiden Handys gleich. Zeigt ein Handy
unter «Mehr › Einstellungen › Startbildschirm» die Erinnerungen (statt des
Schlafs oder mit «Beides» daneben), steht auf «Jetzt» neben der Windel-Karte das Nächste («Als Nächstes
· Vitamin D · 08:00 · in 2 Std.», «Überfällig» ab einer Stunde danach; ein
Tipp auf die Karte hakt es ab) und anstelle von «Schlaf starten» der Knopf
«Erinnerungen» («3 offen»), der die Liste des Tages zum Abhaken öffnet. Ein Haken ist
ein Eintrag vom Typ `task` («Erledigt · Vitamin D», im Verlauf mit Uhrzeit
und Name), der den Zeitplan und den gemeinten Zeitpunkt nennt — so haken
beide Handys denselben Punkt ab. Die Uhrzeiten gelten in Europe/Zurich wie
die Tagesgrenzen; Push-Benachrichtigungen gibt es keine.

## Anleitung

«Mehr» hat vier Bereiche: Erinnerungen, Einstellungen, Konto (das eigene
Konto und darunter alles zur Familie: Familien-Passwort,
Wiederherstellungscode, Export, Verschlüsselungsstatus) und die
**Anleitung** — wie die App benutzt wird, von den vier Tabs über das
Ein-Tipp-Erfassen und die Mahlzeiten bis zu den Schlüsseln (statischer Text
in `src/views/howto.js`). Wer sich auf einem Handy neu registriert, sieht
beim Start eine Meldung «Neu hier? … unter Mehr › Anleitung» mit
«Anzeigen» — bei jedem Start, bis die Anleitung einmal geöffnet wurde;
der Bereich trägt bis dahin einen Punkt.

## Sprachen

Die App gibt es auf Deutsch (Schweizer Wortschatz, die Ausgangssprache)
und Englisch. Jedes Handy wählt seine Sprache unter «Mehr › Einstellungen ›
Sprache» oder auf der Anmeldeseite (Umschalter unter dem Titel); ohne
Wahl folgt die App der Sprache des Handys, sonst Deutsch. Die Wahl bleibt
auf dem Gerät (`prefs.lang`), wie das Design.

Alle Texte liegen in `src/i18n/locales/<sprache>/` — eine Datei pro
Bereich (`home.js`, `more.js`, `howto.js`, …), flache Schlüssel, Deutsch
ist die Vorlage. **Eine neue Sprache** ist ein kopierter `en/`-Ordner plus
ein Eintrag in `src/i18n/locales/index.js`; `npm test` prüft, dass jede
Sprache jeden Schlüssel hat (und keinen zu viel). Die Anleitung für
Übersetzerinnen und Übersetzer samt Glossar: `src/i18n/locales/README.md`.
Server-Fehler kommen mit einem Code (`{error, code, params}`), den der
Client übersetzt; der deutsche Text bleibt als Rückfall dabei.

## Was ist neu

Nach einem Update zeigt die App beim nächsten Öffnen einmal, was sich für
die Eltern geändert hat — als Liste im Bottom-Sheet, nachlesbar unter
«Mehr › Anleitung › Was ist neu». Die Notizen stehen in
`src/whats-new.js`: ein Eintrag pro Deploy, der etwas Sichtbares ändert
(`id` = Datum, neueste zuerst, eine Zeile pro Punkt in jeder Sprache).
Ein Deploy ohne Eintrag aktualisiert still. Vor dem Deploy also: Eintrag
schreiben, wenn die Eltern etwas merken sollen — nicht was im Code
passiert ist, sondern was auf dem Handy anders ist und wo es zu finden
ist. `npm test` prüft Reihenfolge, Eindeutigkeit und dass jede Sprache
ihre Zeilen hat.

## Designs

Unter «Mehr › Einstellungen › Design» wählt jedes Handy sein Aussehen —
«Nachtkinderzimmer» (Standard, dunkel-first), «Swiss» (weiss, schwarze
Linien, Magenta) oder «Bauhaus» (Rot, Gelb, Blau auf Papier). Ein Design ist eine CSS-Datei mit Farb-, Form- und
Schrift-Tokens in `src/themes/`; ein neues entsteht aus `_template.css`
plus einem Eintrag in `src/themes/index.js` — Anleitung und Checkliste in
`src/themes/README.md`.

## Struktur

```
api/            PHP-Backend (index.php Router + lib/ + tests/)
src/            Frontend: main.js Shell, views/, store.js (lokales Modell +
                Sync), session.js (Anmelde-/Schlüsselflüsse), crypto.js,
                model.js/validate.js/tz.js/meals.js/reminders.js/dose.js
                (reine Logik, node-getestet), themes/ (ein CSS pro Design +
                Registry; README dort), i18n/ (Sprachen: locales/<id>/,
                README dort), whats-new.js (die Notizen fürs Update-Sheet)
public/         Manifest, Service Worker, Icons
scripts/        dev-router, preview-router, package.mjs, deploy.mjs,
                export-plain.mjs (Offline-Entschlüsselung), make-icons.mjs
                (zeichnet das Icon-Set nach public/img/), make-screenshots.mjs
                (die Bildschirmfotos der Anmeldeseite)
data/           lokale SQLite-DB (gitignored, nie deployt)
```
