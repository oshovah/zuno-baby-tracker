// «Mehr › Anleitung», the how-to (views/howto.js) — long copy, HTML allowed.
// One key per section title and per paragraph / list item; <strong> stays
// inside the strings, the icon() pictograms stay in code.
export default {
  // The lead paragraph
  'lead': 'Zuno hält fest, wann das Baby getrunken hat, was in der Windel war und wie lange es geschlafen hat – auf beiden Handys derselbe Stand. Das Wichtigste geht mit einem Fingertipp, auch um drei Uhr nachts.',
  // «Die vier Tabs»: one item per tab
  'tabs.title': 'Die vier Tabs',
  'tabs.now': '<strong>Jetzt</strong> – der Stand: seit wann keine Mahlzeit, der Tag bisher (Mahlzeiten und nasse Windeln gegen das Ziel), der Schlaf oder die nächste Erinnerung. Darunter die Knöpfe zum Erfassen.',
  'tabs.log': '<strong>Nachtragen</strong> – alles mit frei wählbarer Zeit, auch Gewicht, Temperatur und Medikamente.',
  'tabs.history': '<strong>Verlauf</strong> – alle Einträge nach Tag, zum Nachschauen, Korrigieren und Löschen.',
  'tabs.more': '<strong>Mehr</strong> – Erinnerungen, Einstellungen, Konto und Familie, diese Anleitung.',
  // «Stillen»: one item per step
  'nursing.title': 'Stillen',
  'nursing.start': '<strong>«Stillen links»</strong> oder <strong>«Stillen rechts»</strong> antippen – fertig. Der Knopf mit <strong>«als Nächstes»</strong> zeigt die Seite, die dran ist: Die Seiten wechseln sich von Mahlzeit zu Mahlzeit ab.',
  'nursing.stop': 'Oben läuft dann eine Uhr. Nach dem Stillen <strong>«Stillen beenden»</strong> antippen, und die Dauer ist gespeichert. Vergessen? Die App fragt später einmal <strong>«Wie lange gestillt?»</strong> – ein Tipp auf 10, 15, 20 oder 30 Minuten genügt. Ohne Antwort bleibt der Eintrag ohne Dauer, das ist auch in Ordnung.',
  'nursing.switch': '<strong>Seite wechseln:</strong> Solange eine Seite läuft, heisst der andere Knopf «Wechseln» – ein Tipp beendet die eine Seite und startet die andere.',
  'nursing.pause': '<strong>Pause:</strong> Braucht das Baby ein Görpsli oder eine Umarmung, beendet <strong>«Pause»</strong> neben «Stillen beenden» die Stillzeit – die Uhr oben zählt dann die Pause; <strong>«Weiter»</strong> macht auf derselben Seite weiter. Die Pause zählt nicht als Stillzeit – im Verlauf sind das zwei Einträge derselben Seite in einer Mahlzeit. Kommt 20 Minuten lang kein «Weiter», gilt die Pause als Ende der Mahlzeit; die Karte oben sagt, wie lange noch. Die pausierte Seite bleibt dann «als Nächstes» – sie war ja noch nicht fertig. «Stillen beenden» auf der Pause-Karte beendet die Mahlzeit sofort, und die Seiten wechseln wieder ab.',
  'nursing.lateStart': '<strong>Zu spät gestartet?</strong> Auf die Uhrzeit unter der Uhr tippen («seit 14:32 ▾»): «+2», «+5», «+8» oder «+10 Min» setzt den Start zurück, «anpassen» öffnet das Formular.',
  // «Schoppen»
  'bottle.title': 'Schoppen',
  'bottle.body': '<strong>«Schoppen»</strong> öffnet das Formular. Zuoberst steht das Ziel pro Mahlzeit – in den ersten zehn Tagen nach der Faustregel (Lebenstag − 1) × 60 ml am Tag, danach ein Sechstel des Körpergewichts am Tag (nach eurem letzten Gewichtseintrag; ohne Gewicht ein Richtwert nach Alter), verteilt auf eure Mahlzeiten (Einstellungen › Trinkmenge); eine empfohlene Menge von der Hebamme (Einstellungen › Empfohlene Menge) gilt stattdessen, sobald sie eingetragen ist – und was am Tag schon im Schoppen war. Zuerst kommt die abgepumpte <strong>Muttermilch</strong>: die Menge tippen oder den ★-Chip wählen, der sie aufs Ziel setzt. Reicht sie nicht, füllt <strong>«Milch (Formula)»</strong> auf – ihr ★-Chip ist genau der Rest bis zum Ziel. Die Zeile darunter zählt zusammen («Zusammen 70 ml · Ziel erreicht»). Die drei anderen Chips jeder Zeile sind eure Schnellwahl – ganze Schoppen bei der Muttermilch, kleine Mengen bei der Milch (Einstellungen › Schoppen-Schnellwahl). Zuerst stillen, dann zuschoppen: Steht unter Einstellungen › Stillen, wie viel das Baby ungefähr an der Brust trinkt, zieht das Formular diese Menge bei einer Mahlzeit mit Stillen vom Ziel ab und zeigt nur noch den Rest.',
  // «Windel»
  'diaper.title': 'Windel',
  'diaper.body': '<strong>«Pipi»</strong>, <strong>«Gaggi»</strong> oder <strong>«Beides»</strong> – ein Tipp, und die Windel ist mit der aktuellen Zeit erfasst. Die Karte «Heute» zählt mit: nasse Windeln gegen die Richtzahl («4/~6»), volle daneben, und wann die letzte war.',
  // «Schlaf»
  'sleep.title': 'Schlaf',
  'sleep.body': '<strong>«Schlaf starten»</strong> beginnt einen Timer, den beide Handys sehen; <strong>«Aufgewacht»</strong> beendet ihn. Früher eingeschlafen? Auf die Karte «Schläft seit …» tippen und den Start korrigieren. Wer den Schlaf nicht erfassen will, stellt unter Einstellungen › Startbildschirm «Erinnerungen» oder «Nichts» ein – «Beides» zeigt Schlaf und Erinnerungen nebeneinander.',
  // «Vertippt?» — the undo toast and editing in Verlauf
  'undo.title': 'Vertippt?',
  'undo.body': 'Nach jedem Tipp erscheint unten eine Meldung mit <strong>«Rückgängig»</strong>. Und jeder Eintrag lässt sich später im Verlauf antippen, ändern oder löschen.',
  // «Mahlzeiten» — how feeds fold into one meal
  'meals.title': 'Mahlzeiten',
  'meals.body': 'Beide Seiten und ein Schoppen dazu zählen als <strong>eine Mahlzeit</strong>, solange zwischen den Einträgen höchstens 20 Minuten liegen – eine Seite vor und nach einer Pause auch. «Seit letzter Mahlzeit» zählt ab dem Ende der Mahlzeit – oder ab ihrem Beginn, wenn «Abstand ab Beginn der Mahlzeit» eingeschaltet ist (Einstellungen), wie es viele Hebammen rechnen. «Heute: 6 Mahlzeiten» zählt Mahlzeiten, nicht Seiten; im Verlauf ist eine Mahlzeit eine Karte mit ihren Seiten darunter.',
  // «Nachtragen»
  'log.title': 'Nachtragen',
  'log.body': 'Für alles, was nicht gerade eben passiert ist: Art wählen, Zeit anpassen, speichern. Stillen und Schlaf haben Start und Ende – «Ende» leer lassen, und der Timer läuft auf «Jetzt» weiter; beim Stillen setzen die Chips «10» bis «30 Min» das Ende ab dem Start. Gewicht, Temperatur, Medikament (die letzten Namen als Chips) und «Erledigt» gibt es nur hier.',
  // «Verlauf» — the four views and paging
  'history.title': 'Verlauf',
  'history.body': 'Alle Einträge nach Tag, die neusten zuoberst, mit einer Tageszeile: Mahlzeiten, nasse Windeln («5/~6» – etwa sechs am Tag sind das Ziel), volle Windeln, Schlaf, Erledigtes. Der Schalter oben rechts wählt die Ansicht: «Einträge» zeigt jeden Tag mit all seinen Einträgen, «Tage» nur die Tageszeilen – ein Tipp auf einen Tag klappt seine Einträge auf, ein zweiter wieder zu –, «Mahlzeiten» nur die Mahlzeiten, zugeklappt: ein Tipp zeigt die Seiten und Schoppen darin, über jedem Tag steht seine Milch und das Tagesziel – und «Grafik» Kurven für 7, 14 oder 28 Tage: Gewicht, Mahlzeiten gegen euer Tagesziel, Stillminuten je Seite, Schoppen-Milliliter (Muttermilch und Milch übereinander), Windeln, Schlaf, Temperatur, jede nur, wenn es dazu Einträge gibt; bei zwei Reihen (Stillen, Schoppen, Windeln) zeigt ein Tipp auf einen Eintrag der Legende – etwa «Pipi» – nur diese Reihe, ein zweiter Tipp wieder beide; über den Balken stehen die Zahlen, wo sie Platz haben, im Kopf der Durchschnitt pro Tag – ohne den heutigen Tag, der ist noch nicht zu Ende; das Filter-Symbol neben den Tagen blendet einzelne Grafiken aus, nur auf diesem Handy. Einen Eintrag antippen, um Zeit, Menge oder Seite zu ändern – oder ihn zu löschen. «Frühere Einträge laden» und «Frühere Mahlzeiten laden» holen jeweils eine Woche mehr, «Frühere Tage laden» vier.',
  // «Erinnerungen»
  'reminders.title': 'Erinnerungen',
  'reminders.body': 'Was täglich zu festen Zeiten ansteht – Vitamin D fürs Baby, ein Medikament für Mama oder Papa – legt ihr unter <strong>Mehr › Erinnerungen</strong> an: was, für wen, die Uhrzeiten – und ob täglich oder alle zwei, drei, sieben Tage, ab einem ersten Tag. Auf «Jetzt» erscheinen sie, sobald unter Einstellungen › Startbildschirm «Erinnerungen» oder «Beides» gewählt ist: Die Karte zeigt, was als Nächstes dran ist, und hakt es mit einem Tipp ab; der Knopf «Erinnerungen» öffnet die Liste des Tages. Ein Haken ist ein Eintrag «Erledigt» – beide Handys sehen ihn; in der Liste nimmt ein zweiter Tipp auf den Haken ihn zurück. Die App schickt keine Mitteilungen, sie zeigt nur, was fällig ist.',
  // «Zu zweit» — the two-phone sync
  'twoPhones.title': 'Zu zweit',
  'twoPhones.body': 'Beide Handys zeigen dieselben Einträge: Die App holt jede Minute und bei jedem Öffnen den neusten Stand. Ein Timer, der auf dem einen Handy gestartet wurde, lässt sich auf dem anderen beenden. Wer etwas erfasst, steht mit dem Anzeigenamen am Eintrag. Ohne Netz zeigt «Jetzt» den letzten Stand («Stand 14:32» oben rechts) – erfassen geht trotzdem: Der Eintrag wird auf dem Handy gespeichert («wartet auf Netz») und gesendet, sobald Zuno offen ist und wieder Netz hat; oben rechts steht, wie viele noch warten, ein Tipp darauf zeigt sie. Hat das andere Handy denselben Eintrag inzwischen beendet, geändert oder gelöscht, gilt dessen Stand, und dieses Handy sagt es.',
  // «Einstellungen» — family vs. this phone
  'settings.title': 'Einstellungen',
  'settings.body': '<strong>«Für die Familie»</strong> gilt auf beiden Handys: die Trinkmenge (Geburtsdatum und Mahlzeiten pro Tag für das berechnete Ziel), die empfohlene Menge, die stattdessen gilt, je drei Schoppen-Mengen für Muttermilch und Milch, ob gestillt wird und wie viel das Baby dabei ungefähr trinkt, der Abstand ab Beginn der Mahlzeit. <strong>«Nur dieses Handy»</strong>: was «Jetzt» im vierten Feld zeigt (Schlaf, Erinnerungen, beides oder nichts), ob der Bildschirm beim Stillen anbleibt, das Design, hell oder dunkel.',
  // «Konto und Familie» + the encryption paragraph
  'account.title': 'Konto und Familie',
  'account.body': 'Unter <strong>Mehr › Konto</strong>: Anzeigename und eigenes Passwort ändern, abmelden (entfernt Schlüssel und Einträge von diesem Handy). Darunter die Familie: das Familien-Passwort (braucht nur, wer beitritt – es gilt für einen Beitritt und verfällt danach; zum Einladen hier ein neues setzen), der Wiederherstellungscode (nach Eingabe deines Passworts – aufschreiben!) und der Export aller Einträge. Ein zweites Elternteil registriert sich mit dem Familiennamen und dem Familien-Passwort und sieht dann dieselben Einträge.',
  'account.encryption': 'Alles ist Ende-zu-Ende verschlüsselt: Ohne dein Passwort, ein gültiges Familien-Passwort oder den Wiederherstellungscode kommt niemand an die Einträge – auch nicht, wer die App betreibt. Darum gibt es kein «Passwort vergessen» per E-Mail: Bewahrt den Code gut auf.',
  // «Als App installieren»
  'install.title': 'Als App installieren',
  'install.body': 'Im Browser-Menü <strong>«Zum Home-Bildschirm»</strong> wählen – die App bekommt ein eigenes Symbol, öffnet ohne Browserleiste und sofort, auch bei schlechtem Empfang.',
};
