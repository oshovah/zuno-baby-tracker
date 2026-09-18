# Zuno – Baby Tracker — Build Spec

A simple tracking webapp for a newborn: feeds, diapers, sleep, and occasional
measurements. Used by both parents from their phones, synced through a shared
backend. Replaces paper notes / memory at 3am — so every common action must be
1–2 taps, big touch targets, mobile-first.

**UI language: German.** Timezone Europe/Zurich, dates/times in Swiss format
(`31.08.2026`, `14:30`). Code, comments, and this spec stay in English.

## Stack

Same architecture as `../workout-tracker` (proven on the same cyon hosting):

- Frontend: vanilla JS + Vite, no framework. Mobile-first CSS.
- Backend: PHP API (single router `api/index.php` + `api/lib/` modules),
  SQLite via PDO, WAL mode. Runs on cyon shared hosting.
- Dev: `npm run dev` = `php -S` + vite concurrently with a dev router.
- Tests: PHP API tests (`api/tests/run.php`) + node unit tests
  (`node --test src/tests/*.test.mjs`: crypto, the local model, the meal
  presentation, the drinking-target rule, reminders, validation, timezone,
  the ui helpers, store/sync, the offline export tool).
- Deploy: copy/adapt workout-tracker's `scripts/package.mjs` +
  `scripts/deploy.mjs` (rsync/sftp/ftp, never touches remote `data/`).
- Config/credentials via gitignored `.env` (see workout-tracker's
  `.env.example` pattern).

## Auth & encryption

Lightweight accounts, grouped into **families**. Login = globally unique
**username** + password; every user also has a display name ("Mama"/"Papa"/
custom) that is written into each entry they log (renaming does not rewrite
history). Registration is ONE form: username, password, display name,
**family name**, **family password** — an unknown family name creates the
family, a known one requires the family password to join. The family
password is a one-time invite: the join replaces the family credentials with
random ones, so it opens nothing afterwards; a member sets a fresh one to let
the next person in, and members themselves never need it (their own password
unlocks any device). Entries belong to a family; families never see each
other, so one install can host several. Session cookie, long-lived (stay
logged in for months), backed by revocable DB tokens bound to a user.
Deliberately minimal: no registration gate, no admin panel, no e-mail —
abuse is bounded instead: per-address and per-target attempt budgets, a
per-address write budget and row caps per family and in total.

**End-to-end encrypted.** The database alone reveals nothing usable: every
entry (type, times, amounts, names) is one AES-GCM blob encrypted on the
phone with a random **family data key**. That key is stored only wrapped:
under a key derived from the family password (so a new member can join) and
under a key derived from each member's own password (so login on a new
device unlocks the data). Passwords never reach the server — the client sends
a derived auth value that is bcrypted there. The server stores usernames,
family names, wrapped keys, salts and day-granular row dates; it computes
nothing. The phone derives the home screen and history from its decrypted
local copy.

Recovery is the user's job: forgot the own password → register a new
username and re-join with the family password (or the recovery code); forgot
the family password → any logged-in member sets a new one; the
**recovery code** (the raw family key, shown once at family creation and
under Mehr after typing the own password) unlocks everything without any
password; `scripts/export-plain.mjs` decrypts a database file offline. Lose
all three with no logged-in device and the data is gone — by design.

Upgrade path from the original one-shared-password version: the schema
migrates in place on the first request (backup `data/baby.db.v1.bak`), every
device logs in once, the first registration repeats the OLD shared password
to adopt the existing entries, and the phone encrypts them ("seal") right
after; the server then vacuums the plaintext away.

## Sync model

The server is the single source of truth for the encrypted rows; each phone
keeps a decrypted copy in memory and a ciphertext mirror in IndexedDB. No
offline-first complexity:

- Incremental sync (`GET /sync?since=<seq>`) when the app gains focus and
  every ~60 s while open, so a timer started on one phone shows up on the
  other. The per-family `seq` is exact (assigned under the SQLite write lock).
- Running timers are open entries (`endedAt: null`) inside the blobs; they
  survive reloads and appear on both phones.
- Writes are compare-and-swap on `seq`: a stale stop/edit gets a 409, the
  phone re-syncs and retries once when its precondition (e.g. "still open")
  still holds — the old `ifOpen` semantics, now for every edit.
- Day windows: "today" counts use the Europe/Zurich day (ported from the old
  server logic), history groups by device-local day — as before.

## Performance & caching

The app must *open* fast even on slow reception; only *fresh data and writes*
need the network:

- Vite hashed assets + far-future cache headers (`.htaccess`) — repeat visits
  load JS/CSS from disk cache.
- Minimal service worker precaching the app shell, plus a manifest so the app
  installs to the home screen and opens instantly regardless of connection.
- The home view is derived locally from the decrypted mirror (IndexedDB
  ciphertext + in-memory plaintext) and painted immediately with a freshness
  stamp ("Stand: 14:32") — the last completed sync — then refreshed in the
  background (stale-while-revalidate). Stale data is clearly marked as stale.
- Writes require network. On failure: clear visible error, no offline queue.

## What gets tracked

| Type | Fields | Notes |
|---|---|---|
| Stillen (breastfeed) | side (L/R), paused?, started_at, ended_at | live timer or after-the-fact; `paused: true` = closed by the hero's «Pause», the side goes on |
| Schoppen (bottle) | amount_ml («Milch (Formula)», the formula), colostrum_ml? (labelled «Muttermilch», first in the form), time | the form shows the day's target per meal (see *Trinkmenge*) and what the day already had; ★ chips fill Muttermilch to the target and the formula up to the rest |
| Windel (diaper) | kind: pee / poop / both, time | one tap per kind |
| Schlaf (sleep) | started_at, ended_at | live timer or after-the-fact |
| Gewicht (weight) | grams, time | occasional |
| Temperatur | °C, time | occasional |
| Medikament | name (free text, e.g. "Vitamin D"), time | remembers recent names |
| Erledigt (task) | title, who (baby/mama/papa), reminderEid?, due?, time | a ticked-off reminder, or a chore logged by hand |

Every entry: editable and deletable afterwards (typos, forgot to stop a
timer). Deletes are soft (`deleted_at`) so nothing is lost by a 3am mistap.

**Erinnerungen (reminders)** are the family's daily schedules: one entry of
type `reminder` per schedule — `details {title, who, note?, times}` («Vitamin
D · 2 Tropfen · Baby · 08:00», «Ibuprofen 600 · Mama · 08:00 · 20:00»), the
times in Zurich wall-clock like the day windows, `startedAt` the last change,
`loggedBy` who made it. Not an event (Verlauf, Nachtragen and the counts skip
it), edited under Mehr › Erinnerungen with compare-and-set like any row. The
phone expands them into the day's to-dos (`src/reminders.js`): one occurrence
per reminder × time with its due instant; a live `task` entry naming the
reminder and that due instant ticks it off, on both phones. A tick whose slot
no longer exists (times edited afterwards) counts for the nearest open slot
of its day; a second tick of a ticked slot (two phones raced) only shows in
Verlauf. No notification fires — the home screen shows what is due.

**Family settings** travel the same way: one entry of type `settings` per
family — its `details` is the settings document (`feedFromStart`,
`recommendedMl`, `bottlePresets` — the Muttermilch chips, historical name —,
`formulaPresets` — the formula's own three, small ones —, `birthDate`,
`mealsPerDay`; every key optional, unknown keys kept so an older shell's save never drops a newer
shell's setting), `startedAt` the
time of the last change, `loggedBy` who made it. Encrypted and synced like
a feed, so the server learns no preference either; the live row with the
highest `seq` counts on every phone; a save lays only the changed keys over
the current document with the row's `seq` as compare-and-set and, on a
409, over the partner's fresh document. It is no event: Verlauf,
Nachtragen and the counts skip it. Until the family has saved a key, a
phone's older per-device value of it stands in. Design, light/dark, the
wake lock and what the home screen's fourth slot shows (Schlaf ·
Erinnerungen · Beides · Nichts) stay per device on purpose (they are about the
phone). Under Mehr › Einstellungen the two groups are «Für die Familie»
and «Nur dieses Handy».

**Trinkmenge** (the drinking target, `src/dose.js`): the plan is breast
first, then pumped Muttermilch to fill up, then formula. The target per
meal for a day is the midwife's `recommendedMl` when set, else the rule of
thumb for the first ten days — (Lebenstag − 1) × 60 ml over the day, shared
by `mealsPerDay` (default 6), rounded to 5 ml; the Lebenstag counts Zurich
calendar days from `birthDate` (1 on the birth day, which has no target).
Past day ten the rule says nothing (`source: 'expired'`) and the form asks
for the midwife's number. Einstellungen › Trinkmenge holds the two keys and
previews today's numbers.

## Core features (MVP)

1. **Home / "Jetzt" view** — the screen that matters:
   - Big "time since" indicators: since the last meal (the number parents
     check most), since last diaper, sleep status (schläft seit … / wach
     seit …). The half-width cards round to half hours from one hour on
     («vor 1½ Std.», «seit 3½ Std.», ui.fmtSpanShort) so they never wrap on
     a narrow phone; the hero keeps the exact numerals.
   - **Mahlzeiten**: feeds (Stillen of either side, Schoppen) at most 20
     minutes apart — end of the meal so far to the next start — count as ONE
     meal. Derived on the phone from the synced entries (`groupMeals` in
     `src/model.js`), never stored, the gap fixed so both phones agree.
     "Seit letzter Mahlzeit" counts from the meal's end — or from its
     start with «Abstand ab Beginn der Mahlzeit» on (Mehr › Einstellungen,
     a family setting; the label then reads «Seit Beginn der letzten
     Mahlzeit»), the way many midwives count feeds — and the card
     shows the whole meal («Links 12 · Rechts 8 — 20 Min., 13:02–13:31»); while
     a later side runs, the live hero names its place in the meal («2.
     Seite» the first time on the other breast, «weiter» after a «Pause»,
     «nochmals» for any other repeat) and keeps the meal total running.
     «Heute: n Mahlzeiten» counts meals, not sides.
     The «als Nächstes» pill alternates the STARTING side per meal (the
     other side than the last meal began with); within 20 minutes of a
     meal's end it offers the other side than the one just fed, and a
     Schoppen in between does not change the answer. A running Stillen
     timer keeps its meal open for later feeds for at most 3 hours after
     its start (a forgotten timer must not swallow the whole day); a side
     that was quick-logged and never stopped leaves the meal without a
     total (its minutes are unknown).
   - The fourth slot is a per-device choice (Mehr › Einstellungen ›
     Startbildschirm): **Schlaf** (the sleep card + «Schlaf starten»),
     **Erinnerungen**, **Beides** or nothing. With Erinnerungen, the card next to the
     diaper card answers what is next («Als Nächstes · Vitamin D · 08:00 ·
     in 2 Std.» — half hours from one hour on, so the line never wraps on a
     narrow phone; «Jetzt fällig» once due, «Überfällig» an hour later;
     «Alles erledigt · morgen 08:00»; «noch keine · anlegen ›») and ticks
     that item off with one tap («Abhaken ✓», a `task` entry, undo in the
     toast), and the sleep
     tile's place holds the «Erinnerungen» tile with a pill («3 offen», red
     once a slot is overdue; «erledigt ✓»; «anlegen ›») that opens today's
     checklist in the bottom sheet: open slots as one-tap rows, ticked ones
     compact below them with time and name, a second tap on a ticked row
     (armed for 3 s) takes the tick back. The screen keeps its one-screen
     height whatever the day holds. A running sleep timer stays visible
     whatever the choice. Next to the reminders (Beides, or a running timer
     with Erinnerungen chosen) the sleep makes a row of three cards (Windel ·
     Schlaf · Erinnerung) and a row of three tiles (Schoppen · Schlaf ·
     Erinnerungen), never a taller screen.
   - Any running timer (Schlaf, or a Stillen entry left open via Nachtragen)
     shown prominently with a stop button. On the live feed hero the start
     time is tappable: one-tap "+2 / +5 / +8 / +10 Min" corrections for the
     timer that was started a few minutes into the feed, plus the full form.
   - Quick action buttons: Stillen L, Stillen R (one tap = one completed
     feed, no timer), Schoppen, Windel (Pipi / Gaggi / Beides), Schlaf
     start/stop.
   - **Pause**: next to «Stillen beenden» the live hero has «Pause» for a
     burp or a hug without switching sides. It closes the side now and marks
     it (`details.paused: true`); the hero then shows the pause running
     (muted), the meal so far and when the pause runs out, with «Weiter»
     (primary, the left slot — the same slot «Pause» had, so a bounce never
     ends the meal) and «Stillen beenden». «Weiter» starts the same side
     again as a quick-logged feed (like «Wechseln» does for the other side);
     the meal folds both entries of the side together and the pause minutes
     count for nobody. The paused state (`ui.pausedFeed`) holds as long as a
     «Weiter» would still join the meal — the meal gap, 20 min after the
     meal's last end — then the pause was the end of the meal; the same
     side stays «als Nächstes» afterwards (the parent said so). A Schoppen
     or the other side logged meanwhile, on either phone, ends the pause on
     both. The validator keeps the mark only on a closed side with a
     duration: reopening the timer or a quick log drops it.
   - While feeding (a running Stillen timer, a quick-logged feed in its
     45-minute live window, or a paused side within its window) the app
     holds a Screen Wake Lock so the phone does not go to sleep; per-device
     switch under Mehr › Einstellungen. Never for Schlaf timers.
2. **Live timers**: starting Schlaf creates an open entry (`endedAt: null`
   inside its encrypted blob) that is synced like any other; stopping sets
   `endedAt` with a compare-and-set on `seq`. Visible on both phones.
   Breastfeed stays a timer type in the model, but the UI only creates open
   feeds via Nachtragen.
3. **Quick log ("Nachtragen" tab)**: every type can also be entered after
   the fact with an editable time (defaults to now) and duration/amount.
4. **History ("Verlauf")**: reverse-chronological list grouped by day, with
   per-day summary counts (x Mahlzeiten, wet diapers against the ~6-a-day
   guide «💧 5/~6», soiled ones, Schlaf total, ticked-off «Erledigt»
   entries). Three views,
   switched in the head: «Einträge» (every visit starts here — leaving the
   tab drops the choice) lists every day with its rows under a head
   carrying the counts, a week per page; «Tage» is one folded row per day —
   the day and its counts — that a tap unfolds (and a second folds again),
   four weeks per page; «Mahlzeiten» shows the feeds only — under each day
   head one folded row per meal (its total, parts and span) that a tap
   unfolds into its sides, a week per page. A
   meal of several feeds is one card — a head with the total («Mahlzeit ·
   20 Min.», «Links 12 · Rechts 8 · 13:02–13:31») and the sides indented
   below it, placed under the day the meal STARTED; every side stays its
   own entry. Tap an entry to edit or delete it.
5. **Simple day stats**: just the per-day summary line in history — no charts.
6. **«Mehr»**: four panes — Erinnerungen, Einstellungen, Konto (the own
   account, then the family: family password, recovery code, export,
   encryption status) and Anleitung, a plain-language how-to of the app
   (the tabs, one-tap logging and its corrections, meals, Nachtragen,
   Verlauf, reminders, the two-phone sync, settings, keys, installing). A
   registration on a device points to it: a toast «Neu hier? … unter Mehr ›
   Anleitung» with «Anzeigen» on every app start until the pane was opened
   once. No interactive walkthrough, no overlays on the home screen.

## Data model (schema v3)

- `families` (id, name, name_key UNIQUE — case-folded, auth_hash = bcrypt of
  the family auth value, kdf_salt, kdf_iter, fdk_wrapped — the family data key
  under the family password's KEK, recovery_hash, created_at DATE)
- `users` (id, family_id, username UNIQUE — lowercased, auth_hash, kdf_salt,
  kdf_iter, fdk_wrapped — the FDK under the member's KEK, profile_blob —
  encrypted `{displayName}`, created_at DATE)
- `entries` (eid TEXT PK — 32 hex, client-generated; family_id; seq — per-
  family change counter = sync cursor and concurrency token; blob — the
  encrypted entry; legacy_* — plaintext of pre-encryption rows until sealed;
  created_at / updated_at / deleted_at as DATES)
  - Inside the blob: `{v, eid, rev, type, startedAt, endedAt, details, loggedBy}`
    with `type`: `breastfeed | bottle | diaper | sleep | weight | temperature |
    medication | task | settings | reminder`, `details` per type: `{side,
    paused?}`, `{amount_ml, colostrum_ml?}`, `{kind}`, `{grams}`, `{celsius}`, `{name}`,
    `{title, who, reminderEid?, due?}`, the family settings document and the
    reminder schedule `{title, who, note?, times}` (see *What gets tracked*);
    canonical UTC ISO times; point-in-time types use `startedAt` only.
  - One open timer per type is a client rule (lower `seq` wins a race).
- `auth_tokens` (hashed session tokens, bound to a user_id)
- `settings` (key, value) — `schema_version`, `salt_secret`, `legacy_max_seq`,
  `feed_id` (random token every sync page carries as `feed`; a re-migrated or
  restored file gets a new one, so phones drop a mirror that belongs to
  another history of the file)
- `login_attempts` (ip, fails, window_start) — every attempt budget: per
  address (`<ip>`, `reg:<ip>`, `write:<ip>`) and per target (`user:<name>`,
  `family:<name key>`); the key prefix picks the budget

One baby only — no `babies` table until reality demands it.

## API sketch

`/api/` routes, JSON in/out; everything but auth itself behind the session:

- public: `GET /me`, `GET /auth/params?username=`, `GET /families/check?name=`,
  `POST /families/unlock`, `POST /register` (create-or-join, one request),
  `POST /login`, `POST /logout`
- keys: `POST /me/keys/unlock`, `PATCH /me` (profile blob),
  `PATCH /me/password`, `PATCH /families/password`
- entries: `GET /sync?since=&limit=` (paged rows + tombstones, `feed`),
  `POST /entries {eid, blob}`, `PATCH /entries/:eid {blob, ifSeq}` (409 when
  moved), `DELETE /entries/:eid` (optional body `{ifSeq}` → 409 when moved),
  `POST /entries/:eid/restore`, `POST /entries/seal` (encrypt migrated
  plaintext rows)
- `GET /state` and the old `GET /entries?from=&to=` answer 410 (old shells)
- `GET /art/<name>`: private artwork. The repo ships its own icon set
  (`public/img/`, drawn by `scripts/make-icons.mjs`); an installation may keep
  other pictures in the gitignored `private-art/` and name ONE family
  (`PRIVATE_ART_FAMILY` in `.env`) that sees them instead. They are packaged
  behind a deny rule and leave the server only through this route, for that
  family's sessions — everyone and everything else gets the same 404. The
  family's sync pages carry `art` (a version string); the phone keeps its copy
  per version (`src/art.js`) and drops it on logout.

## Non-goals (don't build)

- Charts / statistics dashboards
- Offline *writes* (queueing/sync of entries logged without network) — shell
  caching and stale-state display are in scope, see Performance & caching
- Push notifications (the reminders are in-app only: the home screen shows
  what is due, nothing rings)
- Multiple babies, roles/permissions (every family member is equal), admin
  panel, e-mail / server-side password reset (impossible by design: the
  server holds no key)
- Native app; i18n beyond German

## Definition of done

- `npm install && npm run dev` works locally.
- On a phone: log Stillen in one tap, a Windel in one tap (Pipi / Gaggi /
  Beides), and see "seit letzter Mahlzeit" update on the home view.
- A timer started on phone A can be stopped from phone B.
- Editing and deleting an entry works from the history view.
- API tests cover sync paging, compare-and-set writes (PATCH and
  conditional DELETE), soft delete/restore, the legacy seal, the schema
  migration and auth; node model tests cover crypto, the local model (day
  windows, one-open-timer rule, timer open/close, meals, the pause,
  reminders and their ticks), the drinking-target rule and validation.
- `npm run deploy` publishes to the cyon subdomain (same .env mechanism as
  workout-tracker); README covers setup and deploy.
