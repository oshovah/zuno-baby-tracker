// Server error messages by code. api/index.php and api/lib/*.php answer
// {error, code, params?}; src/api.js looks the code up here and shows the
// translation — one key per code, the key IS the code. The German text must
// stay identical to the server's message (src/tests/api-codes.test.mjs
// checks it): an older shell toasts that message verbatim, so both must
// read the same. The first three are src/api.js's own: no answer at all.
export default {
  'network.offline': 'Du bist offline – bitte Internetverbindung prüfen',
  'network.unreachable': 'Keine Verbindung zum Server',
  'request.failed': 'Anfrage fehlgeschlagen ({status})',

  // the request itself (lib/http.php, index.php)
  'request.badJson': 'Ungültiger JSON-Body: {reason}',
  'request.badContentType': 'Ungültiger Content-Type – JSON erwartet',
  'request.methodNotAllowed': 'Methode nicht erlaubt',
  'request.notFound': 'Nicht gefunden',
  'request.notAnInteger': '"{field}" muss eine ganze Zahl sein',
  'request.missingField': '"{field}" fehlt',
  'request.invalidField': '"{field}" ungültig',
  'request.badBlob': 'Ungültiger Datensatz',
  'request.writeBudget': 'Zu viele Änderungen in kurzer Zeit – bitte später nochmals versuchen',
  'server.busy': 'Kurz überlastet – bitte nochmals versuchen',
  'server.internal': 'Serverfehler',

  // accounts and families (lib/auth.php)
  'auth.notLoggedIn': 'Nicht angemeldet',
  'auth.badCredentials': 'Benutzername oder Passwort falsch',
  'auth.missingCredentials': 'Bitte Benutzername und Passwort angeben',
  'auth.badKeyMaterial': 'Ungültige Schlüsseldaten',
  'auth.badUsername': 'Benutzername: {min}–{max} Zeichen – Buchstaben, Ziffern, Punkt, Strich oder Unterstrich',
  'auth.badFamilyName': 'Familienname: {min}–{max} Zeichen',
  'auth.badFamilyMode': 'Ungültige Anfrage',
  'auth.missingFamilyCredential': 'Bitte Familien-Passwort oder Wiederherstellungscode angeben',
  'auth.badFamilyPassword': 'Falsches Familien-Passwort',
  'auth.badRecoveryCode': 'Ungültiger Wiederherstellungscode',
  'auth.familyUnknown': 'Familie nicht gefunden – bitte Namen prüfen',
  'auth.familyExists': 'Familie wurde gerade angelegt – bitte nochmals versuchen',
  'auth.usernameTaken': 'Dieser Benutzername ist bereits vergeben',
  'auth.badPassword': 'Falsches Passwort',
  'auth.missingConfirmation': 'Bitte dein Passwort zur Bestätigung angeben',
  'auth.throttled': 'Zu viele Versuche – bitte später nochmals probieren',

  // entries (lib/entries.php)
  'entries.badId': 'Ungültiger Eintrag',
  'entries.exists': 'Eintrag existiert bereits',
  'entries.notFound': 'Eintrag nicht gefunden',
  'entries.conflict': 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert',
  'entries.familyFull': 'Speicherlimit der Familie erreicht – keine neuen Einträge möglich',
  'entries.serverFull': 'Der Speicher des Servers ist voll – keine neuen Einträge möglich',
};
