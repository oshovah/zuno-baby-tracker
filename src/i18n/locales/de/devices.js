// Physical buttons («Analog-Buttons»): the section under Mehr › Einstellungen (for
// the family) and the sheet that adds, shows and removes one
// (src/device-sheet.js). The feature is «Analog-Buttons» (the section, the
// add button); the thing that is named, added and removed is the «Gerät»
// (one board, up to three buttons), a physical button is a «Knopf», a
// press a «Knopfdruck» — the parents' words.
export default {
  // the section under Einstellungen › Für die Familie
  'section.title': 'Analog-Buttons',
  'section.hint':
    'Echte Knöpfe neben dem Wickeltisch: Ein kleines Gerät mit bis zu drei Tasten – ein Mikrocontroller mit WLAN, die {guide} liegt beim Quellcode – trägt mit einem Druck eine Windel ein (Pipi, Gaggi oder Beides), ohne dass jemand das Handy holt. Jeder Druck wird auf dem Gerät verschlüsselt; der Server sieht nur, dass ein Knopf gedrückt wurde. Das nächste Handy, das abgleicht, macht daraus den Eintrag – mit dem Namen des Geräts.',
  // The link in the hint (lands in innerHTML through the {guide} param)
  'section.guide': 'Bauanleitung',
  'section.empty': 'Noch keine Knöpfe eingerichtet.',
  'section.add': 'Analog-Buttons hinzufügen',
  // a row in the list: the name, the day it was set up
  'section.since': 'seit {day}',
  'section.open': 'Code und Einstellungen',

  // the add form
  'add.title': 'Analog-Buttons hinzufügen',
  'add.intro': 'Gib dem Gerät einen Namen – er steht dann an jedem Eintrag, den es macht. Ein Gerät hat bis zu drei Knöpfe (Pipi, Gaggi, Beides); welcher Knopf was einträgt, steht in seinem Programm. Danach zeigt die App den Code, der dort hineingehört.',
  'add.nameLabel': 'Name',
  'add.namePlaceholder': 'z.B. Wickeltisch',
  'add.submit': 'Gerät anlegen',
  'add.working': 'Wird angelegt …',
  'add.done': 'Gerät «{name}» angelegt',
  'defaultName': 'Wickeltisch',

  // the detail view: the code, the test press, removal
  'detail.title': 'Analog-Buttons',
  'detail.meta': '{name} · eingerichtet: {day}',
  'detail.codeLabel': 'Der Code für das Gerät',
  'detail.codeHint':
    'In das Programm des Geräts eintragen (ZUNO_CODE), dazu die Adresse von Zuno und das WLAN. Der Code enthält den Schlüssel, mit dem das Gerät verschlüsselt – nur das Gerät und die Handys der Familie kennen ihn, der Server nicht. Wer ihn hat, kann Einträge machen: nicht weitergeben. Im Programm steht auch, welcher Knopf was einträgt (Pipi, Gaggi, Beides).',
  'detail.copy': 'Code kopieren',
  'detail.copied': 'Code kopiert',
  'detail.copyFailed': 'Kopieren nicht möglich – bitte den Code markieren und kopieren',
  'detail.sketch': 'Bauanleitung und Programm',
  'detail.test': 'Testdruck senden',
  'detail.testHint': 'Schickt einen Druck genau so, wie das Gerät es täte – eine Pipi-Windel, jetzt. Nach dem nächsten Abgleich steht der Eintrag im Verlauf; dort lässt er sich wieder löschen.',
  'detail.testing': 'Wird gesendet …',
  'detail.tested': 'Testdruck gesendet – der Eintrag kommt mit dem nächsten Abgleich',
  'detail.remove': 'Gerät entfernen',
  'detail.removeConfirm': 'Wirklich entfernen?',
  'detail.removeHint': 'Der Code des Geräts gilt danach nicht mehr; seine Einträge bleiben.',
  'detail.removing': 'Wird entfernt …',
  'detail.removed': 'Gerät «{name}» entfernt',
  'detail.gone': 'Gerät nicht gefunden',
};
