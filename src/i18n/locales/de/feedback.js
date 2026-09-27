// Feedback to the operator: the section under Mehr › Anleitung, the form
// and the operator's inbox (src/feedback-sheet.js). «Die Person, die Zuno
// betreibt» on purpose: the copy fits every installation, not one person.
export default {
  // the section under Anleitung
  'section.title': 'Feedback',
  'section.hint': 'Ein Wunsch, ein Fehler, eine Idee? Schick eine Nachricht – mit Namen oder anonym.',
  'section.send': 'Feedback senden',
  'section.inboxHint': 'Die Nachrichten der Eltern. Lesen kann sie nur dieses Konto.',
  'section.open': 'Postfach öffnen',
  'section.unread': '{n} ungelesen',

  // the form
  'form.title': 'Feedback senden',
  'form.intro': 'Die Nachricht geht an die Person, die Zuno betreibt. Sie wird auf deinem Handy verschlüsselt – lesen kann sie nur diese Person.',
  'form.kindLabel': 'Worum geht es?',
  'form.textLabel': 'Deine Nachricht',
  'form.placeholder': 'Was möchtest du mitteilen?',
  'form.count': '{n}/{max}',
  'form.anonymous': 'Anonym senden',
  'form.anonymousHint': 'Die Nachricht trägt dann keinen Namen, und der Server speichert sie ohne Bezug zu deinem Konto. Beim Senden bist du angemeldet wie bei jeder Anfrage – mit der Nachricht gespeichert wird das nicht.',
  'form.namedHint': 'Mit deinem Namen: {name}',
  'form.tech': 'Technische Angaben mitsenden',
  'form.techHint': 'Hilft bei Fehlern. Gesendet wird genau das:',
  'form.send': 'Senden',
  'form.sending': 'Wird gesendet …',
  'form.sent': 'Danke – Nachricht gesendet',
  'form.unavailable': 'Feedback ist hier nicht eingerichtet.',
  'form.errorKind': 'Bitte wähle, worum es geht',
  'form.errorEmpty': 'Bitte schreib eine Nachricht',
  'form.errorLong': 'Höchstens {max} Zeichen',

  // kinds
  'kind.idea': 'Wunsch',
  'kind.bug': 'Fehler',
  'kind.misc': 'Sonstiges',

  // the inbox
  'inbox.title': 'Postfach',
  'inbox.empty': 'Noch keine Nachrichten.',
  'inbox.loading': 'Wird geladen …',
  'inbox.anonymous': 'Anonym',
  'inbox.new': 'Neu',
  'inbox.unreadable': 'Diese Nachricht lässt sich nicht öffnen.',
  'inbox.tech': 'Technische Angaben',
  'inbox.markUnread': 'Als ungelesen markieren',
  'inbox.markRead': 'Als gelesen markieren',
  'inbox.delete': 'Löschen',
  'inbox.deleteConfirm': 'Wirklich löschen?',
  'inbox.deleted': 'Nachricht gelöscht',
  'inbox.more': 'Ältere laden',

  // the operator's usage numbers under the inbox button (api/lib/stats.php)
  'usage.title': 'Nutzung',
  'usage.hint': 'Nur Zahlen, keine Namen – alle Familien dieser Installation, deine eingeschlossen. Einträge zählen auch Einstellungen, Erinnerungen und Abgehaktes.',
  'usage.families.one': '{n} Familie',
  'usage.families.other': '{n} Familien',
  'usage.familiesActive': '{week} mit Einträgen in den letzten 7 Tagen, {month} in 30 Tagen',
  'usage.accounts.one': '{n} Konto',
  'usage.accounts.other': '{n} Konten',
  'usage.accountsNew': '{n} neu in den letzten 30 Tagen',
  'usage.entries.one': '{n} Eintrag',
  'usage.entries.other': '{n} Einträge',
  'usage.entriesNew': '{n} neu in den letzten 7 Tagen',
  'usage.loading': 'Zahlen werden geladen …',
  'usage.failed': 'Zahlen gerade nicht verfügbar.',
};
