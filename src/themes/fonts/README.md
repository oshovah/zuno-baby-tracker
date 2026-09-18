# Bundled fonts

Self-hosted so that no request ever leaves the app's own origin (the CSP
allows nothing else, and the app promises "kein Tracking"). All three are
under the SIL Open Font License 1.1 — the licence text sits next to each
file and must stay there.

| File                 | Family | Role                                   | Source                               |
| -------------------- | ------ | -------------------------------------- | ------------------------------------ |
| `Inter-latin.woff2`  | Inter  | Helvetica stand-in (Swiss)             | https://github.com/rsms/inter        |
| `Jost-latin.woff2`   | Jost   | Futura revival (Bauhaus)               | https://github.com/indestructible-type/Jost |
| `Nunito-latin.woff2` | Nunito | rounded face where ui-rounded is absent (Nachtkinderzimmer on Android) | https://github.com/googlefonts/nunito |

Each file is the variable-weight (400–800) **latin** subset as served by
Google Fonts (U+0000-00FF plus punctuation: covers German with umlauts, ß,
«guillemets» and dashes) — 27 to 48 KB apiece. They are declared in
`../fonts.css`, hashed into `assets/` by the build, precached by the service
worker, and only downloaded once a design actually uses them.

To add one: drop the woff2 and its OFL here, add an `@font-face` to
`../fonts.css`, name it in your design's `--font` stack, and keep it to a
latin subset (the Google Fonts CSS API returns per-subset files; take the
`/* latin */` one).
