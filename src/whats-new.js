// «Was ist neu»: the release notes a PARENT should read — not a changelog.
// One entry per deploy that changes something they would notice (a new
// switch, a moved button, a changed rule); a deploy without an entry
// updates silently. Newest first; `id` is the deploy's date (`YYYY-MM-DD`,
// add `-b`, `-c` for a second one on the same day — ids only need to sort).
// One line per note, in every language the app ships (a language missing
// on an entry shows the German line). Write it for the phone: what changed
// and where to find it, no version numbers, no file names.
//
// The shell shows the entries newer than prefs.whatsNewSeen once after an
// update (main.js); «Mehr › Anleitung» has a button to re-read them. An id
// that has shipped is final: phones remember it as "seen", and an entry
// with a LOWER id than that would never show there — a later deploy on the
// same day gets `-b`, never a lower date.

export const WHATS_NEW = [
  {
    id: '2026-09-18',
    de: ['Die Schoppenmilch heisst jetzt überall «Formula» statt nach einer Marke: «Milch (Formula)» im Schoppen-Formular, «Formula» im Verlauf und in der Grafik.'],
    en: ['Formula milk is now simply called "Formula" instead of a brand name – in the bottle form, in History and in the charts.'],
  },
  {
    id: '2026-09-17-f',
    de: [
      'Erinnerungen können alle zwei, drei, sieben … Tage wiederholen: im Formular unter «Wiederholen», mit dem ersten Tag. Die Liste unter Mehr › Erinnerungen sagt es dazu («alle 2 Tage»).',
    ],
    en: [
      'Reminders can repeat every two, three, seven … days: in the form under "Repeat", with the first day. The list under More › Reminders says so ("every 2 days").',
    ],
  },
  {
    id: '2026-09-17-e',
    de: [
      'Verlauf hat eine neue Ansicht «Grafik»: Gewicht, Mahlzeiten, Stillminuten, Schoppen, Windeln, Schlaf und Temperatur als Kurven pro Tag – für 7, 14 oder 28 Tage. Das Filter-Symbol blendet Grafiken aus, die dich nicht interessieren (nur auf deinem Handy).',
    ],
    en: [
      'History has a new "Charts" view: weight, meals, nursing minutes, bottles, diapers, sleep and temperature as charts per day – for 7, 14 or 28 days. The filter button hides charts you do not care about (on your phone only).',
    ],
  },
  {
    id: '2026-09-17-d',
    de: ['Die Erinnerungs-Karte auf «Jetzt» sagt, wie viele Erinnerungen überfällig sind («2 Überfällig»), nicht nur, dass eine es ist.'],
    en: ['The reminder card on "Now" says how many reminders are overdue ("2 overdue"), not just that one is.'],
  },
  {
    id: '2026-09-17-c',
    de: [
      'Auf «Jetzt» ist die Karte «Letzte Windel» jetzt die Karte «Heute»: Mahlzeiten gegen euer Tagesziel (Mehr › Einstellungen › Mahlzeiten pro Tag), nasse Windeln gegen die Richtzahl, dazu volle Windeln und die letzte Windel. Die Schlaf-Karte zeigt die Schlafzeit des Tages.',
    ],
    en: [
      'On "Now", the "Last diaper" card is now the "Today" card: meals against your daily target (More › Settings › Meals a day), wet diapers against the guide, plus soiled diapers and the last diaper. The sleep card shows the day\'s sleep.',
    ],
  },
  {
    id: '2026-09-17-b',
    de: [
      'Zuerst stillen, dann zuschoppen: Unter Mehr › Einstellungen › Stillen trägst du ein, wie viel das Baby ungefähr an der Brust trinkt – das Schoppen-Formular zieht das vom Ziel ab und zeigt nur noch den Rest.',
      'Wird nicht mehr gestillt, lässt sich Stillen dort ausschalten: die Stillen-Knöpfe verschwinden, der Schoppen rückt nach vorn.',
    ],
    en: [
      'Nurse first, then top up: under More › Settings › Nursing, enter roughly how much the baby drinks at the breast – the bottle form takes that off the target and shows only what is left.',
      'Once the baby is no longer nursed, nursing can be switched off there: the nursing buttons disappear and the bottle moves up.',
    ],
  },
  {
    id: '2026-09-17',
    de: [
      'Die App gibt es jetzt auch auf Englisch – umschalten unter Mehr › Einstellungen › Sprache, auch auf der Anmeldeseite.',
      'Nach einem Update zeigt die App beim nächsten Öffnen kurz, was neu ist – so wie jetzt. Zum Nachlesen: Mehr › Anleitung.',
    ],
    en: [
      'The app now speaks English – switch under More › Settings › Language, also on the login screen.',
      'After an update, the app shows what changed the next time it opens – like now. To read it again: More › Guide.',
    ],
  },
];

export const WHATS_NEW_SHOW_MAX = 5;

/** The notes of an entry in `locale`, falling back to German (then to whatever it has). */
export function notesFor(entry, locale, fallback = 'de') {
  const pick = (l) => (Array.isArray(entry[l]) && entry[l].length > 0 ? entry[l] : null);
  return pick(locale) || pick(fallback) || Object.values(entry).find((v) => Array.isArray(v) && v.length > 0) || [];
}

/**
 * The entries newer than `seenId` (the newest id the device has shown), the
 * newest first, at most `max`. No seen id (the feature is new to this phone)
 * → the newest `max` entries.
 */
export function unseenWhatsNew(list, seenId, max = WHATS_NEW_SHOW_MAX) {
  const out = [];
  for (const entry of list) {
    if (seenId && entry.id <= seenId) break;
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

/** The id to remember once the sheet was shown: the newest one. */
export function newestWhatsNewId(list = WHATS_NEW) {
  return list.length > 0 ? list[0].id : null;
}
