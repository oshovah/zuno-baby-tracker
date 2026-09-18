// "More › Guide", the how-to (views/howto.js) — long copy, HTML allowed.
// One key per section title and per paragraph / list item; <strong> stays
// inside the strings, the icon() pictograms stay in code. The labels named
// here are the ones the English views show — keep them in step.
export default {
  // The lead paragraph
  'lead': 'Baby Tracker keeps track of when the baby fed, what was in the diaper and how long it slept – the same on both phones. The essentials take one tap, even at three in the morning.',
  // "The four tabs": one item per tab
  'tabs.title': 'The four tabs',
  'tabs.now': '<strong>Now</strong> – where things stand: how long since the last meal, the day so far (meals and wet diapers against the target), sleep or the next reminder. Below that, the buttons for logging.',
  'tabs.log': '<strong>Log</strong> – anything with a time of your choosing, including weight, temperature and medication.',
  'tabs.history': '<strong>History</strong> – every entry by day, to look things up, correct and delete.',
  'tabs.more': '<strong>More</strong> – reminders, settings, account and family, this guide.',
  // "Nursing": one item per step
  'nursing.title': 'Nursing',
  'nursing.start': 'Tap <strong>"Nursing left"</strong> or <strong>"Nursing right"</strong> – done. The button marked <strong>"next up"</strong> shows the side whose turn it is: the sides alternate from meal to meal.',
  'nursing.stop': 'A clock then runs at the top. After nursing, tap <strong>"Stop nursing"</strong> and the duration is saved. Forgot? The app asks once later: <strong>"How long did you nurse?"</strong> – a tap on 10, 15, 20 or 30 minutes is enough. Without an answer the entry stays without a duration, which is fine too.',
  'nursing.switch': '<strong>Switching sides:</strong> while one side is running, the other button reads "Switch" – one tap ends the one side and starts the other.',
  'nursing.pause': '<strong>Pause:</strong> if the baby needs a burp or a cuddle, <strong>"Pause"</strong> next to "Stop nursing" ends the nursing time – the clock at the top then counts the pause; <strong>"Resume"</strong> carries on with the same side. The pause does not count as nursing time – in History these are two entries of the same side in one meal. If there is no "Resume" for 20 minutes, the pause counts as the end of the meal; the card at the top says how long is left. The paused side then stays "next up" – it was not finished yet. "Stop nursing" on the pause card ends the meal right away, and the sides alternate again.',
  'nursing.lateStart': '<strong>Started too late?</strong> Tap the time under the clock ("since 14:32 ▾"): "+2", "+5", "+8" or "+10 min" moves the start back, "adjust" opens the form.',
  // "Bottle"
  'bottle.title': 'Bottle',
  'bottle.body': '<strong>"Bottle"</strong> opens the form. At the top is the target per meal – for the first ten days by the rule of thumb (day of life − 1) × 60 ml a day, spread over your meals (Settings › Feeding amount); an amount recommended by the midwife (Settings › Recommended amount) applies instead as soon as it is entered – and what has already gone into bottles today. Pumped <strong>breast milk</strong> comes first: type the amount or pick the ★ chip, which sets it to the target. If that is not enough, <strong>"Formula"</strong> tops it up – its ★ chip is exactly what is left to the target. The line below adds it up ("Total 70 ml · target reached"). The other three chips of each row are your presets – whole bottles for breast milk, small amounts for formula (Settings › Bottle presets). Nurse first, then top up: if Settings › Nursing says how much the baby roughly drinks at the breast, the form takes that off the target for a meal with nursing and shows only what is left.',
  // "Diaper"
  'diaper.title': 'Diaper',
  'diaper.body': '<strong>"Pee"</strong>, <strong>"Poo"</strong> or <strong>"Both"</strong> – one tap and the diaper is logged with the current time. The "Today" card keeps count: wet diapers against the guide ("4/~6"), soiled ones beside them, and when the last one was.',
  // "Sleep"
  'sleep.title': 'Sleep',
  'sleep.body': '<strong>"Start sleep"</strong> starts a timer both phones can see; <strong>"Woke up"</strong> ends it. Fell asleep earlier? Tap the "Asleep for …" card and correct the start. If you do not want to track sleep, choose "Reminders" or "Nothing" under Settings › Home screen – "Both" shows sleep and reminders side by side.',
  // "Tapped the wrong thing?" — the undo toast and editing in History
  'undo.title': 'Tapped the wrong thing?',
  'undo.body': 'After every tap a message appears at the bottom with <strong>"Undo"</strong>. And every entry can be tapped later in History, changed or deleted.',
  // "Meals" — how feeds fold into one meal
  'meals.title': 'Meals',
  'meals.body': 'Both sides plus a bottle count as <strong>one meal</strong> as long as the entries are at most 20 minutes apart – a side before and after a pause too. "Since last meal" counts from the end of the meal – or from its start when "Count from the start of the meal" is switched on (Settings), the way many midwives count. "Today: 6 meals" counts meals, not sides; in History a meal is one card with its sides underneath.',
  // "Log"
  'log.title': 'Log',
  'log.body': 'For everything that did not just happen: pick the type, adjust the time, save. Nursing and Sleep have a start and an end – leave "End" empty and the timer keeps running on "Now"; for nursing, the chips "10" to "30 min" set the end from the start. Weight, Temperature, Medication (the last names as chips) and "Done" are only here.',
  // "History" — the three views and paging
  'history.title': 'History',
  'history.body': 'Every entry by day, newest at the top, with a day line: meals, wet diapers ("5/~6" – about six a day is the goal), soiled diapers, sleep, things done. The switch at the top right picks the view: "Entries" shows every day with all its entries, "Days" only the day lines (a tap on a day unfolds its entries, a second one folds them again), "Meals" only the meals, folded: a tap shows the sides and bottles inside – and "Charts" curves for 7, 14 or 28 days: weight, meals against your daily target, nursing minutes per side, bottle millilitres (breast milk beside formula), diapers, sleep, temperature, each only when there are entries for it; the filter button beside the days hides single charts, on this phone only. Tap an entry to change its time, amount or side – or to delete it. "Load earlier entries" and "Load earlier meals" fetch one more week each, "Load earlier days" four.',
  // "Reminders"
  'reminders.title': 'Reminders',
  'reminders.body': 'What is due every day at fixed times – vitamin D for the baby, a medication for Mom or Dad – you set up under <strong>More › Reminders</strong>: what, for whom, the times – and whether daily or every two, three, seven days, from a first day. They appear on "Now" as soon as "Reminders" or "Both" is chosen under Settings › Home screen: the card shows what is next up and ticks it off with one tap; the "Reminders" button opens the day\'s list. A tick is a "Done" entry – both phones see it; in the list a second tap on the tick takes it back. The app sends no notifications, it only shows what is due.',
  // "The two of you" — the two-phone sync
  'twoPhones.title': 'The two of you',
  'twoPhones.body': 'Both phones show the same entries: the app fetches the latest state every minute and every time it opens. A timer started on one phone can be stopped on the other. Whoever logs something is named on the entry by their display name. Without a connection, "Now" shows the last known state ("As of 14:32" at the top right) – logging works again once you are back online.',
  // "Settings" — family vs. this phone
  'settings.title': 'Settings',
  'settings.body': '<strong>"For the family"</strong> applies on both phones: the feeding amount (birth date and meals per day for the rule of thumb), three bottle amounts each for breast milk and formula, the recommended amount, whether the baby is nursed and roughly how much it drinks then, whether to count from the start of the meal. <strong>"This phone only"</strong>: what "Now" shows in the fourth slot (sleep, reminders, both or nothing), whether the screen stays on while nursing, the design, light or dark.',
  // "Account and family" + the encryption paragraph
  'account.title': 'Account and family',
  'account.body': 'Under <strong>More › Account</strong>: change your display name and your own password, sign out (removes the keys and entries from this phone). Below that, the family: the family password (only needed by whoever joins – it is good for one join and expires after that; to invite someone, set a new one here), the recovery code (after entering your password – write it down!) and the export of all entries. A second parent registers with the family name and the family password and then sees the same entries.',
  'account.encryption': 'Everything is end-to-end encrypted: without your password, a valid family password or the recovery code nobody can get at the entries – not even whoever runs the app. That is why there is no "forgot password" by e-mail: keep the code somewhere safe.',
  // "Install as an app"
  'install.title': 'Install as an app',
  'install.body': 'In the browser menu choose <strong>"Add to Home Screen"</strong> – the app gets its own icon, opens without the browser bar and right away, even with a poor connection.',
};
