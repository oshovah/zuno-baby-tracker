# Designs

Every look of the app is one CSS file in this folder plus one entry in
`index.js`. A design changes **tokens** (colours, shape, type); the layout and
components in `src/style.css` are shared and only consume those tokens. The
user picks a design under *Mehr › Einstellungen › Design*; the choice is a
per-device preference (`localStorage`, never synced) and becomes
`<html data-theme="…">`. Next to it, *Hell oder dunkel* lets the user force
light or dark instead of following the phone — every design gets that for
free (see *How the tokens are wired*).

| File            | Design                                     |
| --------------- | ------------------------------------------ |
| `nursery.css`   | Nachtkinderzimmer — the default, dark-first |
| `swiss.css`     | Swiss — white, black rules, magenta circles |
| `bauhaus.css`   | Bauhaus — primaries on paper, 2px frames    |
| `_template.css` | Copy this to start a new one                |
| `fonts.css`     | The bundled faces (`fonts/README.md`)       |
| `icons/<id>/`   | A design's SVG icon set (see *Icons*)       |

## Adding a design

1. Copy `_template.css` to `<id>.css`. The id is lowercase letters and
   dashes (`forest`, `high-contrast`); it is both the file name and the
   `data-theme` value. Replace every `my-theme` in the file with it.
2. Change the tokens you mean. Every token is optional — whatever you leave
   out comes from `nursery.css`. Colours are `light-dark(<light>, <dark>)`,
   both variants side by side; a design with a single look writes plain
   colours instead (it then ignores the phone's setting and the override).
3. Register it in `index.js`: `import './<id>.css'` and one `THEMES` entry
   with `id`, a German `name` and a one-line German `description` (the UI is
   German, Swiss flavour: Schoppen, Gaggi, «guillemets», no ß).
4. `npm run dev`, pick it under *Mehr › Einstellungen*, walk through the
   checklist below, then `npm test` and `npx vite build`.

That is all: no JS beyond the registry entry, no changes to `style.css`.

## Rules that keep every design usable

- **Contrast.** `--ink`, `--muted` and `--faint` are read at 3am in a dark
  room and at noon outdoors: ≥ 4.5:1 against `--bg` *and* `--surface`.
  `--on-milk` ≥ 4.5:1 on `--milk` (it is the primary-button label). Each event
  hue is also used as small text on `--surface` (hero labels, mini-card
  titles): keep those ≥ 4.5:1 too.
- **Four hues, far apart.** Parents recognise the cards by colour before they
  read them: `--milk` (Stillen/Schoppen, also the accent), `--diaper`,
  `--sleep`, `--measure` must stay distinguishable — including for red/green
  colour vision, so vary lightness as well as hue.
- **No third-party fonts.** `--font` names a system face or a font bundled
  in `fonts/` (Inter, Jost, Nunito so far; OFL, latin subset, 27–48 KB,
  declared in `fonts.css`, precached by the service worker). A font from an
  outside host would be a tracking request and is blocked by the CSP anyway.
- **Tokens first, overrides last.** If a look needs more than tokens, scope a
  few component rules to `[data-theme='<id>']` at the bottom of your file.
  Never change the layout: touch targets (≥ 44 px), the tab bar, the bottom
  sheet and the hero grid are the same for everyone.
- **Both variants or one, on purpose.** Native pickers and the
  `light-dark()` tokens follow the same colour scheme, so a two-variant
  design is always consistent. A single-look design must still read well
  with native controls of the other mode (they follow the phone or the
  override; the design's plain colours do not).

## Icons

Every pictogram goes through `icon(name)` in `src/ui.js`: an emoji by
default (that is the Nachtkinderzimmer look). A design may replace them with
its own monochrome SVGs — one file per name in `icons/<id>/`, painted as a
CSS mask in `currentColor`, so they take the hue of the tile or text they
sit in. In your design file:

```css
[data-theme='my-theme'] { --ico-glyph: none; --ico-svg: block; }
[data-theme='my-theme'] .ico[data-ico='breastfeed'] { --ico: url('./icons/my-theme/breastfeed.svg'); }
```

Provide **all** names or none: `breastfeed`, `bottle`, `sleep`, `wake`,
`pee` (also used for `diaper`), `poop`, `both`, `weight`, `temperature`,
`medication`, `task`, `reminder`, `sync`, `lock`, `bolt`, `care`, `phone` —
the list is `ICONS` in `src/ui.js`. A missing one renders as a solid square. Draw on a 24 × 24
grid, in any single colour (only the alpha counts), a few hundred bytes each;
the build inlines them into the CSS. `icons/swiss/` (bold geometric) and
`icons/bauhaus/` (circle, square, triangle) are the two references.

## Checklist before you open a merge request

- Home with a running Stillen timer (the «Pause» + «Stillen beenden» row
  under it must not wrap on a 320 px phone) and with none; the paused hero
  («Pause · links» above the timer, which ticks in `--muted`; «Weiter» +
  «Stillen beenden» below); a running Schlaf card;
  the Erinnerungen card and checklist (Mehr › Einstellungen › Startbildschirm).
- The Schoppen sheet with the target block, the ★ chips and the sum line;
  the entry form date pickers; Einstellungen › Trinkmenge (a date and a
  number input side by side).
- Verlauf in all three views: «Einträge» with a day of entries, «Tage» with
  one day unfolded and «Mahlzeiten» with one meal unfolded (the folded rows,
  their `--surface-2` open state and the turning chevrons); the delete
  button in the edit sheet.
- Login and registration screens, including an error and an ⓘ overlay.
- A toast with an action (stop a timer → «Rückgängig»).
- Both light and dark, if the design has both.

## How the tokens are wired

`nursery.css` defines every token on `:where(:root)` — zero specificity, so
any `[data-theme='…']` rule wins regardless of load order — and again on
`[data-theme='nursery']` so the picker's swatch can show it while another
design is active. The swatch is a `<span data-theme="<id>">` whose children
use `var(--bg)` etc.: custom properties resolve on the nearest element that
defines them, so every design previews itself without any JavaScript.

Light and dark: `src/style.css` sets `color-scheme: light dark` on `:root`,
so by default the phone decides; `light-dark()` in a token resolves against
the colour scheme of the element that uses it. The override under Mehr is
one inline `color-scheme: light|dark` on `<html>` (`applyScheme` in
`index.js`) — every token and every native control flips with it, and no
design needs a media query. (`light-dark()` needs a 2024 browser: iOS 17.5,
Chrome 123, Firefox 120 — the phones this ships to.)
