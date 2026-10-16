# Zuno – Baby Tracker

A small, self-hosted newborn tracker for two parents — nursing, bottles,
diapers, sleep, measurements and daily reminders, shared between both phones
and **end-to-end encrypted**: everything about the baby reaches the server
as ciphertext, and it never sees a password.

No e-mail address, no tracking, no third-party requests, no app store. The
client is a vanilla-JS PWA (Vite; its only runtime dependencies are the
map's — Leaflet, protomaps-leaflet and pmtiles, bundled from npm, nothing
from a CDN), the server a tiny PHP 7.4+ API over SQLite that runs on cheap
shared hosting. The «Karte» tab shows changing tables and nursing places
from OpenStreetMap — and the places parents report in the app, checked by
the operator — on a map this server hosts itself (see «Map» below). The UI
ships in German (Swiss flavour, the source language) and English.

This repository is public so that anyone can check the privacy claims the app
makes. The product decisions are in [SPEC.md](SPEC.md); code, comments and
this documentation are in English, the UI labels quoted here are the German
ones the app shows.

## At a glance

- **Frontend:** vanilla JS + Vite, mobile-first, installable as a home-screen
  app (manifest + service worker; the shell opens at once even on a bad
  connection).
- **Backend:** PHP 7.4+ (`api/`), SQLite (WAL). Accounts live in families:
  every person has their own login (username + password) and a display
  name (Mama / Papa / …), every family a name and a family password that
  serves only to join and expires with every join (a member sets a new one
  to invite the next person). Entries belong to the family — one
  installation can host several families that never see each other.
  Sessions are database tokens in a six-month cookie.
- **End-to-end encrypted:** every entry (kind, times, amounts, names) is
  encrypted on the phone with a random family key. The server stores
  usernames, family names, wrapped keys and the encrypted records — and can
  read none of it. The one exception is the places parents report on the
  map: public map data in the clear, with no link to an account (see «Map»).
  Passwords never leave the phone (the server sees a derived value), so
  there is no password reset by the operator — see «Keys and recovery».
- **Sync:** the server is the source of truth for the encrypted records;
  every phone keeps a decrypted copy in memory and computes the «Jetzt»
  screen itself. The app syncs in the foreground (~60 s) and on focus;
  running timers live in the records and can be stopped from the other
  phone (a stale stop is refused).
- **Without network:** logging still works — the entry is stored encrypted
  on the phone («wartet auf Netz»), shown at once and sent as soon as Zuno
  is open and the network is back. If the other phone ended, changed or
  deleted the same entry meanwhile, that version wins and the phone says
  so. Sending happens only while the app is open.

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
| Throttle counters keyed by the client's address (failed logins, registrations, entry writes, feedback messages, reported places) — rows older than a day are pruned at the next login or registration | |
| Which parts of the self-hosted map a phone asks for while the «Karte» tab is open (byte ranges of one archive — ordinary access-log material) | Where the phone is: the position stays on the phone, and the map never comes from a map provider |
| Feedback messages to the operator (optional, see «Feedback»): per message ONE blob sealed on the phone to the operator's inbox key, a day-granular date and a read mark — no column for the sender | What a message says and who wrote it: a named message carries the name inside the blob, an anonymous one nowhere |
| Map places reported by parents (optional, see «Feedback»): the position, the kind of place, a name and a note in plaintext — public map data, nothing about a baby —, pending or approved, two day-granular dates — no column for who reported it | Who reported a place: the row has no user or family column, and the request is throttled per address like a feedback message |
| Analog buttons (see «Analog buttons»): per device the family and the SHA-256 of its token; per press ONE blob sealed on the device, the device, the family and a day-granular date — deleted once a phone has made the entry | What a press means or when it happened: the key that seals a press is made on the phone and never sent; the device's name lives inside an encrypted entry |

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

Requirements: Node 20+ **and PHP ≥ 7.4 with `pdo_sqlite` on the PATH** — the
dev server and `npm test` call the `php` CLI. Without PHP, Vite still starts
and every API request ends in «Keine Verbindung zum Server».

```bash
npm install
npm run dev     # PHP API on :8788 + Vite on :5173 (proxies /api)
npm test        # PHP API tests (api/tests/*.test.php) + node tests (src/tests/)
```

There is no dev password: on the first open choose «Neues Konto erstellen» —
username, password (8 characters or more), display name, family and family
password. An unknown family name creates the family (and shows the recovery
code once); a known name needs the right family password, then the account
joins — and that family password expires with the join (a member sets a new
one under «Mehr › Konto» when someone else is to join). The database is
created automatically at `data/baby.db`.

On a phone in the LAN, `crypto.subtle` only works over HTTPS
(`http://192.168…` is no secure context): to test on the device, give the
dev server a certificate (for example `@vitejs/plugin-basic-ssl`) or let the
phone reach `localhost` through USB port forwarding.

To deploy, copy `.env.example` to `.env`, fill in the `DEPLOY_*` values and
run `npm run package` / `npm run deploy` — any host with PHP and Apache-style
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
The map is yours as well: its places and tiles are cut from OpenStreetMap on
your machine (`npm run map:data`, `npm run map:basemap`; the area is
`BBOX` in [`scripts/lib/map-config.mjs`](scripts/lib/map-config.mjs)) and
uploaded once with `npm run deploy:basemap` — see «Map».

The pictures in the login page's slider are the real app with invented data,
taken by `npm run screenshots` ([`scripts/make-screenshots.mjs`](scripts/make-screenshots.mjs):
a scratch database, headless Chrome, a week of a newborn written through the
app's own code — needs Chrome, PHP and Node 22+). Re-run it after a change
to one of the screens it shows.

## Keys and recovery

Three things open a family's entries — the server has none of them:

1. **Your own password.** At login it unwraps the family key for this
   device — on a new phone too; a member never needs the family password
   for that. Forgotten? Register with a **new username** and join again —
   with the recovery code, or with a family password the other person sets
   anew beforehand; every entry stays, the old account stays unused.
2. **The family password.** Needed only to join, and a one-time key: with
   the join, the joining phone replaces it with random values nobody knows
   (`rotateFamily` in the registration), so a guessed or passed-on family
   password opens nothing after the join. Someone else to join? Every
   logged-in member sets a new one under «Mehr › Konto» (confirmed with
   their own password) and passes it on; whoever is in stays logged in.
3. **The recovery code.** The raw family key (43 characters), shown once
   when the family is created and under «Mehr › Konto» after entering your
   own password. With it you create a new account in the family without any
   password («Mit Wiederherstellungscode» on the login screen). Write it
   down.

Lose all three with no device logged in, and the data is gone — the price
of the encryption. The reserve: **«Daten exportieren»** under «Mehr › Konto»
writes every entry decrypted into a JSON file; store one somewhere safe now
and then.

An offline export from a database file (a backup, say) works with the
recovery code or a currently set family password (the old one expires with
every join — set a new one under «Mehr › Konto» first), without a server
(needs the `sqlite3` command line on the PATH; `--family <name>` when the
file holds several families; deleted entries are left out):

```bash
node scripts/export-plain.mjs data/baby.db > export.json
node scripts/export-plain.mjs data/baby.db --recovery-code > export.json
```

No admin panel, no e-mail: the operator can delete accounts in the database
but set no password and read no entry (see «Managing accounts by hand»). In
the app the operator's account only reviews what parents send it: feedback
and reported places for the map.

## Deployment

Once: copy `.env.example` to `.env` and fill in the `DEPLOY_*` credentials.

```bash
npm run map:data  # fetch the map's places (Overpass) – before packaging, see «Map»
npm run package   # build + assemble deploy/
npm run preview   # test deploy/ locally: http://127.0.0.1:8081 (also under /baby/)
npm run deploy    # upload deploy/ (rsync / sftp / ftp as set in .env)

npm run map:basemap -- --build YYYYMMDD   # cut the basemap (once per build)
npm run deploy:basemap                    # … and upload it (once; never with the app)
npm run deploy:beta                       # the same to a second installation (.env.beta)
```

- **Map:** `npm run map:data` before packaging (without `public/map/pois.json`
  the package step aborts); the basemap archive (`basemap/`, ~570 MB) goes up
  separately once per build — `npm run deploy:basemap` uploads the archive
  first, then `index.json`, then checks that the server serves byte ranges
  (206). The first time: archive first, then the app.
- **A second installation (a test server):** `.env.beta` next to `.env` with
  its own `DEPLOY_PATH` and `DEPLOY_URL` (no `DEPLOY_DB_PATH` — the database
  then lives in that docroot); `npm run deploy:beta` and
  `npm run deploy:basemap:beta` use that file.
- Re-deploys **never** touch the remote `data/` — the database on the server
  stays.
- Health check: after the upload `deploy.mjs` calls `<DEPLOY_URL>/api/me`.
  That is the first request after the upload, and it runs any pending
  database migration (200 = done, 500 = rolled back, the file untouched; the
  reason is in the PHP error log). Before the v3 → v4 migration the API
  writes one copy next to the database (`baby.db.v3.bak`) — delete it after
  a few quiet days.
- The packaged `.htaccess` sets a Content-Security-Policy (own scripts
  only): with encryption in the browser, injected JavaScript is the last
  remaining attack path. Plus `nosniff`, `Referrer-Policy: same-origin` and
  HSTS.
- **The database outside the docroot** (optional, recommended): by default it
  lives at `<docroot>/data/baby.db`, protected by two `.htaccess` rules.
  `DEPLOY_DB_PATH` in `.env` writes another location into the packaged
  `api/config.php`, and nothing hangs on `.htaccess` any more: absolute, or
  relative to the docroot with `../` (for example `../baby-data/baby.db` —
  on shared hosting the absolute path is often unknown). Keep the order —
  at a missing path the API creates an **empty** database (a new feed id,
  no accounts: every phone would be logged out):
  1. At a quiet moment (at night, no timer open) create a directory next to
     the docroot in the hoster's file manager or over FTP (say `baby-data`,
     writable for the web server) and **move** `baby.db`, `baby.db-wal` and
     `baby.db-shm` there (move, not copy; all three).
  2. Set `DEPLOY_DB_PATH=../baby-data/baby.db` in `.env`, `npm run package`,
     `npm run deploy` — the health check `/api/me` must answer 200; then sync
     once on a phone.
  3. The empty `data/` in the docroot may stay (only the deny stub is in it).
  Back: move the files back, clear the variable, deploy again.

## Schema migrations

The schema is versioned (`settings.schema_version`) and detected
structurally; a migration runs inside the first request after a deploy, in
one transaction, and an older release opens a newer file unchanged (it never
reads the tables it does not know).

**v3 → v4.** Schema v3 still had five `legacy_*` columns in `entries`: entries
from before the encryption lay there in plaintext until a phone of the
family had encrypted them. v4 drops those columns together with the code
that read them — since then the API has no place that takes or returns an
entry's content. Entries, accounts, sessions and the phones' sync cursors
stay as they are. A v3 file that still holds a **live** plaintext entry (or
one without a family) is **refused** and left untouched: the health check
reports 500, the reason is in the error log. Then deploy the last v3
release again, let a phone of the family finish encrypting, and deploy
anew. To check beforehand on the server (`sqlite3 data/baby.db`) — the
result must be 0:

```sql
SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL AND (family_id IS NULL
  OR legacy_type IS NOT NULL OR legacy_started_at IS NOT NULL OR legacy_ended_at IS NOT NULL
  OR legacy_details IS NOT NULL OR legacy_logged_by IS NOT NULL);
```

**v4 → v5** only adds the table `feedback` (id, blob, created_at as a date,
read_at) — no column for the sender, the account or the family.
**v5 → v6** only adds the table `spots` (id, status, lat, lon, kinds, name,
note, created_at and decided_at as dates) — the places parents report on
the map, no column for who reported them; plus, at the first approval, the
counter `settings.spots_version`. **v6 → v7** only adds the tables `devices`
(id, family_id, token_hash, created_at as a date) and `device_events` (id,
device_id, family_id, blob, created_at as a date) — the analog buttons and
their sealed presses, no column for a name, a key or what was pressed. None
of these three touches another table or needs a backup copy, and no phone
re-syncs.

## Managing accounts by hand

Directly in the SQLite file (`sqlite3 data/baby.db`, on the server over
SSH). Passwords and entries can **not** be read or set here — the hashes
belong to derived values, the records are encrypted.

```sql
SELECT id, username, family_id, created_at FROM users;
SELECT id, name, name_key, created_at FROM families;     -- name_key = the lowercased name
SELECT family_id, COUNT(*) FROM entries GROUP BY family_id;
```

Remove an account (an old one forgotten after a recovery, say) or log it
out everywhere:

```sql
DELETE FROM auth_tokens WHERE user_id = <id>;
DELETE FROM users WHERE id = <id>;
```

Delete a whole family (irreversible):

```sql
DELETE FROM entries WHERE family_id = <id>;
DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE family_id = <id>);
DELETE FROM users WHERE family_id = <id>;
DELETE FROM families WHERE id = <id>;
VACUUM;
```

Users can **not** be moved to another family (their wrapped key belongs to
the old one) — register anew and join instead.

## API (quick reference)

Every endpoint lives under `/api`, JSON in and out, errors as
`{"error": "…", "code": "…"}`. `POST`, `PATCH` and a `DELETE` with a body
require `Content-Type: application/json` (415 otherwise); every response is
`Cache-Control: no-store`. Login, registration and every password
confirmation are throttled per IP (10 attempts / 15 min → 429) and
additionally per target — username or family name — from any number of
addresses (20 / hour). Entry writes are limited to 300 / 15 min per IP
(429), and new entries stop at 50 000 rows per family or 400 000 in total
(507; deleted entries count, they stay as tombstones) — registration is
open, and without these limits a stranger's account could fill the disk.
Feedback messages have a budget of their own (10 / hour per IP) and their
own cap (2000), so have reported places (10 / hour per IP; 200 open, 5000
rows) and the presses of analog buttons (60 / hour per IP; 200 unprocessed
per family, 10 devices per family). «Operator» = the account named in
`ADMIN_USERNAME`; everyone else gets the same 404 on those routes. The
client never sends a password, only an `authKey` derived from it (PBKDF2 +
HKDF); keys and records are base64url blobs.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/me` | – | `{authenticated, user}` — `user` = `{username, familyId, familyName, profileBlob}` (also the health check) |
| `GET /api/auth/params?username=` | – | `{kdf: {salt, iter}}` to derive the login value (a stable fake for unknown names) |
| `GET /api/families/check?name=` | – | `{exists, name, kdf}` — does the family exist already? |
| `POST /api/families/unlock` | – | `{familyName, familyAuthKey \| recoveryAuthKey}` → `{kdf, fdkWrapped}` (the family-wrapped key, only after verification) |
| `POST /api/register` | – | `familyMode: create` (with all key material) or `join` (with `rotateFamily`: new family credentials that replace the family password in the same step) → 201 `{ok, user, familyCreated, familyClosed}` + cookie |
| `POST /api/login` | – | `{username, authKey}` → `{ok, user, kdf, fdkWrappedUser}` + cookie |
| `POST /api/logout` | – | revoke the token |
| `POST /api/me/keys/unlock` | ✓ | `{authKey}` → `{kdf, fdkWrappedUser}` (a device without the key) |
| `PATCH /api/me` | ✓ | `{profileBlob}` (the encrypted display name) |
| `PATCH /api/me/password` | ✓ | `{currentAuthKey, authKey, kdf, fdkWrappedUser}` — logs the other devices out |
| `PATCH /api/families/password` | ✓ | `{currentAuthKey, familyAuthKey, familyKdf, fdkWrappedFamily}` |
| `GET /api/sync?since=&limit=` | ✓ | `{serverNow, feed, rows, next}` — pages from `seq`, tombstones included; `reset: true` when the cursor is ahead of the database; a changed `feed` (another database file) makes the client start over too. Plus `feedback: true` when a feedback inbox exists and, for the operator's account only, `feedbackUnread`; with an operator configured `spots` (the version of the approved places) and, operator only, `spotsPending`; `deviceEvents` while presses of the family's analog buttons wait for a phone |
| `POST /api/entries` | ✓ | `{eid, blob}` → the row (507 at the family's or the database's row cap) |
| `PATCH /api/entries/:eid` | ✓ | `{blob, ifSeq}` → the row (409 when another device got there first) |
| `DELETE /api/entries/:eid` | ✓ | soft delete; an optional JSON body `{ifSeq}` makes it conditional (409 when another device got there first) |
| `POST /api/entries/:eid/restore` | ✓ | undo a soft delete |
| `GET /api/feedback/key` | ✓ | `{publicKey}` — the inbox's public key (404 while feedback is off or not set up) |
| `POST /api/feedback` | ✓ | `{blob}` → 201 — a sealed message, stored without a sender (413 too long, 429 after 10 / hour per address, 507 at 2000 messages) |
| `POST /api/feedback/key` | operator | `{publicKey, privateSealed}` — sets the inbox up once (409 afterwards) |
| `GET /api/feedback?before=` | operator | `{publicKey, privateSealed, items, next, unread}` — newest first, 100 per page |
| `PATCH /api/feedback/:id` · `DELETE /api/feedback/:id` | operator | `{read}` read / unread · delete for good |
| `GET /api/stats` | operator | usage numbers: `{asOf, families, familiesActive7, familiesActive30, accounts, accountsNew30, entries, entriesNew7}` — counts only |
| `POST /api/spots` | ✓ | `{lat, lon, kinds, name?, note?}` → 201 — a reported place, pending until reviewed; stored without a sender (400 invalid, 429 after 10 / hour per address, 507 at 200 open or 5000 rows; 404 while no operator is configured) |
| `GET /api/spots` | ✓ | `{version, items}` — the approved places every phone lays over its map |
| `GET /api/spots/pending` | operator | `{items}` — the open reports, oldest first |
| `PATCH /api/spots/:id` · `DELETE /api/spots/:id` | operator | `{approve?, name?, note?, kinds?}` correct and/or approve · reject or withdraw (for good) |
| `POST /api/devices` | ✓ | → 201 `{id, token, createdAt}` — a device (analog buttons) of the family; the token is shown once and stored only as a hash (507 from 10 per family) |
| `DELETE /api/devices/:id` | ✓ | remove a device: the token stops working at once, waiting presses go with it |
| `POST /api/devices/events` | – | `{token, blob}` → 201 — a sealed press of the device (no cookie; 404 for an unknown token, 429 after 60 / hour per address, 507 at 200 unprocessed presses of the family) |
| `DELETE /api/devices/events/:id` | ✓ | a press the phone has turned into an entry |
| `GET /api/art/k/<key>/<name>` | – | the same pictures and `manifest.webmanifest` through the installation's random key (only the members of that family get it, as `artKey` in the sync) — for what the browser fetches without a session: the install icon. Wrong key, unknown name, feature off: the same 404 |
| `GET /api/art/<name>` | (✓) | private artwork (`image/png`) for the members of the family named in `PRIVATE_ART_FAMILY` — the same 404 for everyone else, logged in or not (see «Private artwork») |

Foreign `eid`s → 404. The entry types in the blob's plaintext: `breastfeed
{side, paused?}`, `bottle {amount_ml, colostrum_ml?}`, `diaper {kind}`,
`sleep`, `weight {grams}`, `temperature {celsius}`, `medication {name}`,
`task {title, who, reminderEid?, due?}` (a ticked-off item), and the
non-events `settings` (the family's settings document), `reminder {title,
who, note?, times}` (a daily schedule) and `device {id, name, token, key}`
(an analog-buttons device with its secrets); times are UTC ISO; at most one
open timer per type and family (a client rule — in a race the one saved
first wins).

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

## Feedback

Optional: the parents can write to whoever runs the installation — a wish,
a bug report, anything — under «Mehr › Anleitung», by name or anonymously.
Name your own account in `.env` (`ADMIN_USERNAME`) and package; that one
account sees an inbox there instead of the form — and the places parents
report for the map (below). Unset, the section does not appear.

The messages are end-to-end encrypted like everything else
([`api/lib/feedback.php`](api/lib/feedback.php),
[`src/feedback.js`](src/feedback.js), `sealFeedback` in
[`src/crypto.js`](src/crypto.js)). The first time the operator opens the
inbox, their phone makes an ECDH P-256 key pair: the public half goes to the
server (every member's phone fetches it to write), the private half is sealed
under the operator's family data key, so their other phones and the recovery
code open it too. Each message is sealed to the public key with a throwaway
key pair (ECDH → HKDF-SHA256 → AES-GCM, padded to 1 or 4 KB), so the server
— or a leaked database — holds a blob it cannot read, and the sending phone
cannot read it back either. The inbox routes answer 404 to everyone else.

An anonymous message has no name inside, and the stored row has no user or
family column for either kind, so the server cannot tell the two apart. The
send request itself is made while logged in, like every request, and is
throttled per address only (10 an hour — a per-account counter would write
down the link the table leaves out); what the web server logs about any
request (time, address) it logs about this one too.

Below the inbox, the operator's account also sees a few usage numbers
([`api/lib/stats.php`](api/lib/stats.php)): how many families and accounts
the installation has, how many accounts are new this month, how many rows
are stored and how many families logged something in the last 7 / 30 days
(judged by the rows' day-granular dates). Counts only, no names — nothing
the database does not show whoever runs it anyway, and `GET /api/stats` is
the same 404 for everyone else.

**Reported places.** With an operator configured, the «Karte» tab also
offers «Ort hinzufügen»: a parent moves the map until the crosshair sits on the
place, says what is there (a changing table, a place to nurse), a name and
where exactly, and sends it. Unlike everything else this is stored in the
clear ([`api/lib/spots.php`](api/lib/spots.php), table `spots`): a
position, a kind, a name and a note are public map data, not family data —
and the row has no user or family column, the request is throttled per
address only (10 an hour), so a report is anonymous by construction. The
operator's account sees the open reports under «Mehr › Anleitung»
(«Gemeldete Orte»), approves them as they are or with corrections, or
rejects them; approved places are served by `GET /api/spots` to every
member's phone, which lays them over the OpenStreetMap file and keeps the
list for offline. Rejecting and withdrawing delete the row for good. The
caps: 200 open reports, 5000 rows.

## Analog buttons («Analog-Buttons»)

Optional hardware: a small Wi-Fi microcontroller with real push buttons —
next to the changing table — that logs a diaper (or anything else) with one
press, no phone needed. The sketch and the build guide are in
[`arduino/`](arduino/) (written for the Arduino Nano ESP32; any ESP32
works).

The encryption holds all the way ([`api/lib/devices.php`](api/lib/devices.php),
[`src/devices.js`](src/devices.js), `sealPress` in
[`src/crypto.js`](src/crypto.js)). Under Mehr › Einstellungen › Analog-Buttons a
member registers a device: the server hands out an id and a **token** it
keeps only as a hash; the phone makes a **key** the server never gets. Both
go into an entry of type `device` — encrypted under the family data key, so
the family's other phones have them too — and, joined, into the one code
the sketch wants. The device seals every press with the key (AES-256-GCM,
hardware-accelerated; a press is padded to 128 bytes so «Pipi» and «Gaggi»
have the same length on the wire) and posts it with the token: no cookie,
no account. The server stores the sealed press for the family; every sync
page of the family carries the waiting presses, and the first phone that
syncs opens them, writes the entries through the normal path (a
deterministic id per press, so the two phones never make two; the device's
name as the logger) and deletes the presses. A press nobody can read, or
one with a wrong clock, is dropped with a notice. «Testdruck senden» in the
app sends one press exactly as the device would, to prove the path without
the hardware.

The device learns the time from the installation's own `Date` header, so
no third party is involved on that side either. Removing a device in the
app kills its token at once; its entries stay. Limits: 10 devices per
family, 200 unread presses per family, 60 presses an hour per address.

## Reminders

Under «Mehr › Erinnerungen» the family sets up what is due daily at fixed
times — «Vitamin D · 2 Tropfen · 08:00» for the baby, «Ibuprofen 600 · 08:00
· 20:00» for Mama. A schedule is an encrypted entry like any other (type
`reminder`), so both phones hold the same list. When a phone shows the
reminders under «Mehr › Einstellungen › Startbildschirm» (instead of the
sleep, or next to it with «Beides»), the «Jetzt» screen shows the next item
beside the diaper card («Als Nächstes · Vitamin D · 08:00 · in 2 Std.»,
«Überfällig» from an hour after; a tap on the card ticks it off) and, in
place of «Schlaf starten», the button «Erinnerungen» («3 offen») that opens
the day's checklist. A tick is an entry of type `task` («Erledigt · Vitamin
D», in the Verlauf with time and name) that names the schedule and the
instant it stands for — so both phones tick the same item. The times are
Europe/Zurich wall-clock like the day windows; there are no push
notifications.

## The guide, languages, what's new, designs

**The guide.** «Mehr» has four panes: Erinnerungen, Einstellungen, Konto
(your own account and, below it, everything about the family: family
password, recovery code, export, encryption status) and the **Anleitung** —
how the app is used, from the five tabs through one-tap logging and meals
to the keys (static copy in `src/views/howto.js`). Whoever registers on a
phone sees a note at start, «Neu hier? … unter Mehr › Anleitung» with
«Anzeigen» — at every start until the guide has been opened once; the pane
carries a dot until then.

**Languages.** The app comes in German (Swiss vocabulary, the source
language) and English. Every phone chooses its language under «Mehr ›
Einstellungen › Sprache» or on the login page (the switch under the title);
without a choice the app follows the phone's language, else German. The
choice stays on the device (`prefs.lang`), like the design. All copy lives
in `src/i18n/locales/<language>/` — one file per area (`home.js`,
`more.js`, `howto.js`, …), flat keys, German is the template. **A new
language** is a copied `en/` folder plus an entry in
`src/i18n/locales/index.js`; `npm test` checks that every language has
every key (and none too many). The guide for translators, with the
glossary: `src/i18n/locales/README.md`. Server errors come with a code
(`{error, code, params}`) the client translates; the German text travels
along as the fallback.

**What's new.** After an update the app shows once, at the next open, what
changed for the parents — a list in the bottom sheet, readable again under
«Mehr › Anleitung › Was ist neu». The notes are in `src/whats-new.js`: one
entry per deploy that changes something visible (`id` = the date, newest
first, one line per note in every language). A deploy without an entry
updates silently. So before a deploy: write the entry if the parents should
notice something — not what happened in the code, but what is different on
the phone and where to find it. `npm test` checks the order, the uniqueness
and that every language has its lines.

**Designs.** Under «Mehr › Einstellungen › Design» every phone picks its
look — «Nachtkinderzimmer» (the default, dark-first), «Swiss» (white, black
rules, magenta) or «Bauhaus» (red, yellow, blue on paper). A design is one
CSS file of colour, shape and type tokens in `src/themes/`; a new one starts
from `_template.css` plus an entry in `src/themes/index.js` — the guide and
checklist are in `src/themes/README.md`.

## Map

The fifth tab shows changing tables and nursing places — everything
OpenStreetMap knows in Switzerland and across the border
(`changing_table=*`, `baby_feeding=*`) — on a map this server serves itself.
The login page's promise («nothing outside the hosting») and the CSP hold
here too: no tile server, no CDN, no Overpass query from the phone.

- **Places:** `npm run map:data` asks Overpass (the main instance and its
  two mirrors that hold the whole planet; a second round on an error) for
  the box in `scripts/lib/map-config.mjs` and writes `public/map/pois.json`
  (~160 KB, gitignored; it ships with every build, the map shows its date).
  `scripts/map-data.mjs`; the normalisation and the wording are pure in
  `src/mapdata.js` (node-tested).
- **Additions:** `scripts/map/extra-places.csv` holds places OpenStreetMap
  does not know (yet) and details for places where the changing table is
  not mapped there yet — one row per place, the columns are OSM keys
  (`changing_table`, `baby_feeding`, `level` …) plus `use` (yes/no), source,
  check date and note. `npm run map:data` asks Overpass what already stands
  at that spot (an object of the same kind, 30 m for a point, 60 m for an
  area): if it carries the tag already, OSM stays the source («covered»);
  if it lacks it, the OSM object gets the row's details («merged», the OSM
  link stays); if nothing is there, a point of its own is added («added»,
  without an OSM link). Rooms open only to the members of an institution do
  not belong in it. The better place for every row is OpenStreetMap itself
  — entered there, it becomes «covered» on the next run.
- **Reported places:** with an operator configured (`ADMIN_USERNAME`) the
  map shows «Ort hinzufügen»: move the map until the cross sits on the place
  (from zoom 15), say what is there, a name and «Wo genau?», send. The
  report goes to the server without a name (`api/lib/spots.php`, table
  `spots`: position, kind, name, note in the clear — public map data, no
  column for an account or a family, throttled per address only). The
  operator's account reviews it under Mehr › Anleitung («Gemeldete Orte»:
  approve, correct, reject, withdraw later — with the nearest known place
  as a duplicate warning). Approved places come from `GET /api/spots`; every
  phone lays them over the OSM file (`src/spots.js`, `store.spots`), fetches
  the list only when its version on the sync page moved, and keeps it in
  `localStorage` (`bt.spots`) for the first paint and offline. In the sheet
  such a place reads «Von Eltern gemeldet, vom Betreiber geprüft», without
  an OSM link.
- **Basemap:** `npm run map:basemap -- --build YYYYMMDD` cuts, with the
  `pmtiles` CLI (`brew install pmtiles`), an archive for the same box out of
  the daily Protomaps planet build (zoom 0–14, ~570 MB; `--maxzoom 15`
  doubles it) into `basemap/basemap-<build>.pmtiles`, plus `index.json`
  (what the app loads) and `LICENSE.txt`. The folder is gitignored and not
  part of `deploy/`: `npm run deploy:basemap` uploads it once per build to
  `<DEPLOY_PATH>/basemap/` and checks that the server serves byte ranges
  (206) — that is how the phone reads the tiles. Locally a Vite plugin
  (`scripts/lib/map-assets-plugin.mjs`, also in the headless runs) and the
  preview router serve it with ranges. A new build gets a new file name; an
  archive is never overwritten in place.
- **On the phone:** Leaflet and protomaps-leaflet draw the tiles on canvas
  (`src/map-engine.js`, loaded when the tab is first opened; no worker, no
  font files, no sprites); the pins are DOM elements in the design's
  colours, from zoom 11. «Mein Standort» on tap only (geolocation; the
  position never leaves the phone). Three buttons at the bottom:
  «Info/Einstellung» (where the data comes from, its date, the attribution
  — a small attribution link sits over the map's corner too — and the start
  view), «Ort hinzufügen» and «Orte in der Nähe» (the ten nearest in the
  sheet — works without the map, without network, without the archive on
  the server). Where the map stands when it opens, every phone sets in that
  sheet: «Aktuellen Kartenausschnitt übernehmen» takes the view behind the
  sheet (`prefs.mapStart`). The service worker lets range requests and
  `basemap/` bypass its cache; `map/pois.json` stays cached.
- **What the server learns:** which byte ranges of the archive a phone
  reads while the map is open (ordinary access-log material) — not the
  position. Whoever reports a place sends its position, kind, name and note
  (without an account; the throttle counts per address).
- **Licence:** data © OpenStreetMap contributors, ODbL; the map shows the
  attribution, `basemap/LICENSE.txt` travels with the archive. The
  additions in `scripts/map/extra-places.csv` are public domain (CC0 1.0)
  so that anyone may carry them into OpenStreetMap; a row that takes its
  point or tags from an OSM object says so in its note — that part stays
  ODbL. Nursing places are still thinly mapped in OpenStreetMap (October
  2026: 15 in the box, next to 800 changing tables) — more come only through
  entries there.
- **Another area:** change the box in `scripts/lib/map-config.mjs` and run
  both scripts again.

## Structure

```
api/            PHP backend (index.php router + lib/ + tests/)
src/            frontend: main.js shell, views/, store.js (local model +
                sync), session.js (login / key flows), crypto.js,
                model.js/validate.js/tz.js/meals.js/reminders.js/dose.js
                (pure logic, node-tested), themes/ (one CSS per design +
                registry; README there), i18n/ (languages: locales/<id>/,
                README there), whats-new.js (the notes of the update sheet),
                feedback.js + feedback-sheet.js (feedback to the operator),
                mapdata.js (the map's places, pure) + map-engine.js (Leaflet,
                lazy) + views/map.js (the «Karte» tab), spots.js +
                spots-sheet.js (reported places: report, review) + pois.js
                (the places file, loaded once), devices.js + device-sheet.js
                (the analog buttons: code, test press, removal)
arduino/        the sketch for the analog buttons (Arduino Nano ESP32) + build guide
public/         manifest, service worker, icons; map/pois.json (generated, gitignored)
basemap/        the map archive + index.json (generated, gitignored, uploaded on its own)
scripts/        dev-router, preview-router, package.mjs, deploy.mjs,
                export-plain.mjs (offline decryption), make-icons.mjs
                (draws the icon set into public/img/), make-screenshots.mjs
                (the login page's pictures), map-data.mjs + map-basemap.mjs
                (the map: places and archive), map/extra-places.csv (the
                additions), lib/map-config.mjs (the box),
                lib/map-assets-plugin.mjs (ranges in the dev server), lib/csv.mjs
data/           the local SQLite database (gitignored, never deployed)
```

## Licence

[GNU Affero General Public License v3.0](LICENSE). In short: use it, host it,
change it — but if you run a modified version for other people, you have to
offer them your source too. For an app whose whole point is that you can check
what it does, that seemed the right rule. The icon set is original work,
drawn by [`scripts/make-icons.mjs`](scripts/make-icons.mjs). The bundled fonts
(Inter, Jost, Nunito) are under the SIL Open Font License, their licence texts
sit next to them in [`src/themes/fonts/`](src/themes/fonts/). The map's
places and tiles (`public/map/pois.json` and `basemap/`, both generated — see
«Map») are OpenStreetMap data under the
[Open Database License](https://www.openstreetmap.org/copyright): the map
shows the attribution, and `basemap/LICENSE.txt` travels with the archive.
The places parents report in the app are the installation's own data, not
OpenStreetMap's.
The hand-kept additions in
[`scripts/map/extra-places.csv`](scripts/map/extra-places.csv) are dedicated
to the public domain ([CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/))
so that anyone may carry them into OpenStreetMap; a row that takes its point
or tags from an OSM object says so in its note, and that part stays OSM's.
