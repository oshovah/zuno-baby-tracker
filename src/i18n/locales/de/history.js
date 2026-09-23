// «Verlauf» and «Nachtragen» (views/history.js, views/backfill.js).
export default {
  // The view's heading — the same word as the tab (shell.tab.history), kept
  // apart so a language may shorten the tab without touching the heading.
  title: 'Verlauf',
  // The segmented switch in the head: its accessible name and the views (the
  // fourth, «Grafik», sits with its own keys further down)
  'viewSwitch.label': 'Ansicht',
  'view.entries': 'Einträge',
  'view.days': 'Tage',
  'view.meals': 'Mahlzeiten',
  // The paging button under the list, one per view
  'loadMore.entries': 'Frühere Einträge laden',
  'loadMore.days': 'Frühere Tage laden',
  'loadMore.meals': 'Frühere Mahlzeiten laden',
  // Nothing in the loaded range, one per view
  'empty.entries': 'Keine Einträge in diesem Zeitraum.',
  'empty.days': 'Keine Einträge in diesem Zeitraum.',
  'empty.meals': 'Keine Mahlzeiten in diesem Zeitraum.',
  'view.charts': 'Grafik',
  'empty.charts': 'Noch keine Daten für eine Grafik.',
  // The range chips of «Grafik»
  'range.label': 'Zeitraum',
  'range.days': '{n} Tage',
  // The charts: titles, the day number on the axis, the guide lines
  'empty.filtered': 'Alle Grafiken ausgeblendet – über das Filter-Symbol wieder einblenden.',
  'filter.label': 'Grafiken ein- oder ausblenden',
  'filter.title': 'Grafiken',
  'filter.hint': 'Gilt nur auf diesem Handy. Eine Grafik ohne Einträge bleibt ohnehin weg.',
  'chart.dayLabel': '{n}.',
  // A row's second line while its write waits in the outbox
  'pending.waiting': 'wartet auf Netz',
  'pending.parked': 'vom Server abgelehnt',
  'chart.weight': 'Gewicht',
  'chart.since': 'seit {date}',
  'chart.meals': 'Mahlzeiten pro Tag',
  'chart.target': 'Ziel {n}',
  'chart.nursing': 'Stillen · Minuten pro Tag',
  'chart.left': 'Links',
  'chart.right': 'Rechts',
  'chart.bottleMl': 'Schoppen · ml pro Tag',
  'chart.diapers': 'Windeln pro Tag',
  'chart.guide': '~{n}',
  'chart.sleep': 'Schlaf · Stunden pro Tag',
  'chart.temperature': 'Temperatur',
  // A day whose rows none of the chips count (a weight, say): «1 Eintrag» / «3 Einträge»
  'entryCount.one': '{n} Eintrag',
  'entryCount.other': '{n} Einträge',
  // The placeholder before the first sync and the paging button while it works
  loading: 'Laden …',
  // «Nachtragen»: the heading and the line under it; the type tiles read common.type.*
  'backfill.title': 'Nachtragen',
  'backfill.hint': 'Mit frei wählbarer Zeit – für alles, was unterwegs passiert ist.',
};
