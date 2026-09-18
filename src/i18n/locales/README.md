# Translations

Every language the app ships is one folder here: `de/` (German, the app's
home language and the fallback) and `en/`. A folder holds `meta.js` and one
file per **namespace** — the screen or module the strings belong to:

| file          | what it covers                                                          |
| ------------- | ----------------------------------------------------------------------- |
| `common.js`   | shared words: entry types, sides, who, units, the buttons every sheet has |
| `shell.js`    | the tab bar, start-up toasts, the update toast, the «What's new» sheet   |
| `home.js`     | the «Jetzt / Now» screen                                                 |
| `history.js`  | «Verlauf / History» and «Nachtragen / Log»                               |
| `more.js`     | the «Mehr / More» panes: reminders, settings, account, the guide's frame |
| `login.js`    | the login screen: login, register, recovery, unlock, the pitch           |
| `authInfo.js` | the ⓘ sheets on the login screen                                         |
| `howto.js`    | the how-to under More › Guide (long copy, HTML allowed)                  |
| `forms.js`    | the bottom-sheet forms: entries, reminders, the to-do checklist          |
| `errors.js`   | error messages the phone produces itself                                 |
| `api.js`      | error messages the server answers with (by code)                         |

Each file exports a flat object: `'key': 'text'`. The namespace is added
by the loader, so `home.js` → `'hero.since'` is read as `t('home.hero.since')`.

## Adding a language

1. Copy `en/` to a new folder named by its two-letter code (`fr/`, `it/`, …).
2. Fill in `meta.js`: `id` (the folder name), `name` (in that language, what
   the picker shows), `dateLocale` (for `Intl.DateTimeFormat`, e.g. `fr-CH`),
   `decimalSeparator`.
3. Translate every file. Keep the keys exactly as they are — only the text
   changes.
4. Register it in `../locales/index.js` (one import, one entry in `LOCALES`).
5. Run `npm test`: `src/tests/i18n.test.mjs` checks that every language has
   every key of `de/`, no key `de/` lacks, no empty text, and the same
   `{placeholders}` in every language.

A missing key falls back to German at run time, so a half-done language
still runs — the test is what keeps it from shipping half done.

## Rules for the text

- **Placeholders** are `{name}` and are filled verbatim: keep them, move
  them freely (`'{n} entries'` / `'{n} Einträge'`), never translate the name.
- **Plurals** are two keys, `'thing.one'` and `'thing.other'`, read with
  `tn('ns.thing', n)`; `{n}` is always available. English and German only
  have these two forms; a language with more would extend `tn` in
  `src/i18n/index.js`.
- **HTML** is allowed only where the German text already has it (the
  how-to, the ⓘ sheets, the pitch): those strings land in `innerHTML`.
  Everything else is plain text.
- **Tone**: German is informal («du»), Swiss spelling («ss», never «ß»),
  Swiss words (Schoppen, Gaggi). English is plain and short. Both are
  written for a parent at 3 am: short sentences, no jargon.
- **Names stay**: Baby Tracker, Claude, the family's names. No product
  brands: the formula milk is «Formula», whatever tin a family buys.

## Glossary (German → English)

The words the app is built around. Every language should settle its own
list first so the same thing reads the same on every screen.

| German                        | English                 |
| ----------------------------- | ----------------------- |
| Jetzt · Nachtragen · Verlauf · Mehr | Now · Log · History · More |
| Erinnerungen · Einstellungen · Konto · Anleitung | Reminders · Settings · Account · Guide |
| Familie · Familien-Passwort   | Family · Family password |
| Stillen (links/rechts)        | Nursing (left/right)     |
| Stillen beenden · als Nächstes | Stop nursing · next up  |
| Pause · Weiter                | Pause · Resume           |
| Schoppen                      | Bottle                   |
| Muttermilch · Milch (Formula) | Breast milk · Formula    |
| Trinkmenge                    | Feeding amount           |
| Windel · Pipi · Gaggi · Beides | Diaper · Pee · Poo · Both |
| Schlaf · wach seit            | Sleep · awake for        |
| Mahlzeit · seit letzter Mahlzeit | Meal · since last meal |
| Gewicht · Temperatur · Medikament · Erledigt | Weight · Temperature · Medication · Done |
| Wiederherstellungscode        | Recovery code            |
| Benutzername · Anzeigename    | Username · Display name  |
| Hebamme · Wochenbett          | Midwife · postpartum weeks |
| Mama · Papa                   | Mom · Dad                |
| Min. · Std. · Tagen           | min · h · days           |
| Heute · Gestern · gerade eben | Today · Yesterday · just now |
| Speichern · Abbrechen · Löschen · Rückgängig · Schliessen | Save · Cancel · Delete · Undo · Close |

## How the code reads a string

```js
import { t, tn } from '../i18n/index.js';

el.textContent = t('home.hero.since');                  // plain text
el.innerHTML = t('home.hero.who', { name: escapeHtml(name) }); // HTML: escape the params
label = tn('history.diapers', count);                   // '1 diaper' / '3 diapers'
```

Strings are read when they are shown, never at module load (a label kept
in a `const` at the top of a file would stay in the language the app
started with). Objects that map values to labels use getters for that
reason (`TYPE_META` in `src/ui.js`).
