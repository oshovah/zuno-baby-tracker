// "History" and "Log" (views/history.js, views/backfill.js).
export default {
  // The view's heading — the same word as the tab (shell.tab.history), kept
  // apart so a language may shorten the tab without touching the heading.
  title: 'History',
  // The segmented switch in the head: its accessible name and the three views
  'viewSwitch.label': 'View',
  'view.entries': 'Entries',
  'view.days': 'Days',
  'view.meals': 'Meals',
  // The paging button under the list, one per view
  'loadMore.entries': 'Load earlier entries',
  'loadMore.days': 'Load earlier days',
  'loadMore.meals': 'Load earlier meals',
  // Nothing in the loaded range, one per view
  'empty.entries': 'No entries in this period.',
  'empty.days': 'No entries in this period.',
  'empty.meals': 'No meals in this period.',
  'view.charts': 'Charts',
  'empty.charts': 'No data for a chart yet.',
  // The range chips of "Charts"
  'range.label': 'Range',
  'range.days': '{n} days',
  // The charts: titles, the day number on the axis, the guide lines
  'empty.filtered': 'All charts hidden – show them again via the filter button.',
  'filter.label': 'Show or hide charts',
  'filter.title': 'Charts',
  'filter.hint': 'Applies to this phone only. A chart without entries stays away anyway.',
  'chart.dayLabel': '{n}',
  'chart.weight': 'Weight',
  'chart.since': 'since {date}',
  'chart.meals': 'Meals per day',
  'chart.target': 'Target {n}',
  'chart.nursing': 'Nursing · minutes per day',
  'chart.left': 'Left',
  'chart.right': 'Right',
  'chart.bottleMl': 'Bottle · ml per day',
  'chart.diapers': 'Diapers per day',
  'chart.guide': '~{n}',
  'chart.sleep': 'Sleep · hours per day',
  'chart.temperature': 'Temperature',
  // A day whose rows none of the chips count (a weight, say): "1 entry" / "3 entries"
  'entryCount.one': '{n} entry',
  'entryCount.other': '{n} entries',
  // The placeholder before the first sync and the paging button while it works
  loading: 'Loading …',
  // "Log": the heading and the line under it; the type tiles read common.type.*
  'backfill.title': 'Log',
  'backfill.hint': 'Set the time yourself – for everything that happened on the go.',
};
