// The ⓘ sheets of the login screen (views/auth-info.js): one key per title,
// per paragraph and per list item. The block structure (paragraphs, lists,
// sub-headings) lives in the view; only inline HTML (<strong>, <br />) is
// allowed here — the strings land in innerHTML.
export default {
  // «Drei Schlüssel» — the block the reset sheet shares
  'threeKeys.title': 'Drei Schlüssel',
  'threeKeys.own': '<strong>Dein Passwort</strong> – entsperrt die Einträge auf deinen Geräten.',
  'threeKeys.family':
    '<strong>Das Familien-Passwort</strong> – braucht nur, wer der Familie beitritt, und gilt für genau einen Beitritt: Danach verfällt es. Wer jemanden einladen will, setzt unter «Mehr › Konto» ein neues.',
  'threeKeys.recovery':
    '<strong>Der Wiederherstellungscode</strong> – wird beim Anlegen der Familie angezeigt (später wieder unter «Mehr › Konto»). Er öffnet die Einträge ganz ohne Passwort.',
  // «Wie funktioniert das?» on the registration form
  'howto.title': 'So funktioniert die Registrierung',
  'howto.whatIsFamily':
    'Eine Familie sind alle, die dasselbe Baby erfassen – meist Mama und Papa. Alle in der Familie sehen dieselben Einträge und Timer.',
  'howto.stepCreate':
    '<strong>Die erste Person legt die Familie an:</strong> Konto erstellen, einen neuen Familiennamen eintippen, ein Familien-Passwort wählen. Danach zeigt die App den Wiederherstellungscode – aufschreiben.',
  'howto.stepJoin':
    '<strong>Die zweite Person tritt bei:</strong> eigenes Konto erstellen, denselben Familiennamen und das Familien-Passwort eingeben. Damit ist die Tür zu – das Familien-Passwort verfällt mit dem Beitritt.',
  'howto.stepDone':
    '<strong>Fertig.</strong> Beide Handys zeigen dieselben Einträge; ein Timer, der auf dem einen gestartet wurde, lässt sich auf dem anderen stoppen.',
  'howto.moreMembers':
    'Noch jemand (Grosseltern, Nanny)? Ein Mitglied setzt unter «Mehr › Konto» ein neues Familien-Passwort und gibt es weiter – nach dem Beitritt verfällt auch dieses.',
  'howto.nameCheck': 'Ob ein Familienname schon existiert, siehst du beim Tippen direkt unter dem Feld.',
  'howto.privacyTitle': 'Privatsphäre',
  'howto.privacy':
    'Auf dem Server liegen nur Benutzernamen und Familiennamen. Jeder Eintrag, jede Uhrzeit, jede Menge und dein Anzeigename werden auf dem Handy verschlüsselt, bevor sie es verlassen. Der Schlüssel steckt in deinem Passwort – wer die App betreibt, kann weder mitlesen noch ein Passwort zurücksetzen. Keine E-Mail-Adresse, keine Telefonnummer.',
  // ⓘ next to the username field
  'username.title': 'Benutzername',
  'username.purpose': 'Dein Name zum Anmelden – andere sehen ihn nicht, bei den Einträgen erscheint der Anzeigename.',
  'username.rules':
    '2 bis 30 Zeichen (Buchstaben, Ziffern, Punkt, Strich, Unterstrich), Gross-/Kleinschreibung spielt keine Rolle. Er muss in der ganzen App eindeutig sein: «mama» ist vermutlich schon vergeben, «linas.mama» oder «anna.k» eher nicht.',
  'username.remember': '<strong>Merk ihn dir</strong> – es gibt keine E-Mail-Adresse, an die er geschickt werden könnte.',
  // ⓘ next to the password field
  'password.title': 'Passwort',
  'password.purpose':
    'Dein persönliches Passwort, mindestens 8 Zeichen – jede Person in der Familie hat ihr eigenes. Am besten ein kurzer Satz aus drei, vier Wörtern.',
  'password.neverLeaves':
    'Es verlässt dein Handy nie: Daraus wird der Schlüssel berechnet, der die Einträge entschlüsselt. Der Server sieht nur eine Prüfsumme – darum gibt es keinen «Passwort vergessen»-Link. Am besten im Passwort-Manager des Handys speichern.',
  'password.forgotten':
    'Trotzdem vergessen? Dann erstellst du ein neues Konto mit einem neuen Benutzernamen und trittst wieder bei – mit dem Wiederherstellungscode oder mit einem Familien-Passwort, das die andere Person vorher unter «Mehr › Konto» neu setzt. Alle Einträge bleiben erhalten.',
  // ⓘ next to the display-name field
  'displayName.title': 'Anzeigename',
  'displayName.purpose':
    'So heisst du bei den Einträgen, zum Beispiel «Windel · Mama». Frei wählbar und wie die Einträge verschlüsselt – der Server kennt ihn nicht.',
  'displayName.change':
    'Unter «Mehr › Konto» jederzeit änderbar; bisherige Einträge behalten den Namen, unter dem sie erfasst wurden.',
  // ⓘ next to the family-name field
  'family.title': 'Familie',
  'family.purpose':
    'Der Name eurer Familie – frei wählbar, zum Beispiel der Nachname oder der Name des Babys. Gross- und Kleinschreibung spielt keine Rolle.',
  'family.newOrExisting':
    '<strong>Neuer Name:</strong> Du legst die Familie an und wählst ihr Familien-Passwort.<br /><strong>Bestehender Name:</strong> Du trittst bei – mit dem Familien-Passwort, das dir jemand aus der Familie gegeben hat.',
  'family.scope': 'Wer zur Familie gehört, sieht und bearbeitet alles. Andere Familien sehen nichts.',
  // ⓘ next to the family-password field
  'familyPassword.title': 'Familien-Passwort',
  'familyPassword.purpose':
    'Der Einladungs-Schlüssel eurer Familie, mindestens 8 Zeichen – nicht dein persönliches Passwort.',
  'familyPassword.oneTime':
    'Wer die Familie anlegt, wählt es. Wer beitritt, gibt es zusammen mit dem Familiennamen ein und bekommt damit den Schlüssel zu den Einträgen – und mit dem Beitritt verfällt es: Danach kann es niemand mehr benutzen, auch wer es kennt. Gib es nur Leuten weiter, die alle Einträge sehen dürfen.',
  'familyPassword.nextPerson':
    '<strong>Noch jemand?</strong> Wer schon in der Familie ist, setzt unter «Mehr › Konto» ein neues und gibt es weiter. Ist niemand mehr angemeldet, hilft der Wiederherstellungscode.',
  // «Wozu?» / «Mehr dazu» on the recovery form
  'recovery.title': 'Wiederherstellungscode',
  'recovery.what':
    'Der Code aus 43 Zeichen, den die App beim Anlegen der Familie angezeigt hat. Er ist der Schlüssel zu allen Einträgen – wer ihn hat, kann alles lesen. Darum gehört er auf Papier oder in den Passwort-Manager, nicht in eine Chat-Nachricht.',
  'recovery.use':
    'Damit legst du hier ein neues Konto in eurer Familie an – ganz ohne Passwort. Alle Einträge bleiben erhalten, das alte Konto bleibt einfach liegen, und der Code gilt weiterhin.',
  'recovery.format':
    'Gross- und Kleinschreibung zählt; die Leerzeichen zwischen den Blöcken darfst du weglassen. Wer angemeldet ist, findet den Code unter «Mehr › Konto» nach Eingabe des eigenen Passworts.',
  // «Warum?» on the unlock screen
  'unlock.title': 'Warum nochmals das Passwort?',
  'unlock.why':
    'Du bist noch angemeldet, aber auf diesem Gerät fehlt der Schlüssel zu den Einträgen – das passiert, wenn der Browser Website-Daten gelöscht oder das Handy Speicherplatz freigeräumt hat.',
  'unlock.what':
    'Aus deinem Passwort berechnet die App den Schlüssel neu und legt ihn wieder auf dem Gerät ab. An den Server geht dabei nichts, was die Einträge lesbar machen würde.',
  'unlock.forgotten':
    'Passwort vergessen? Mit «Anderes Konto» ein neues anlegen und wieder beitreten – mit dem Wiederherstellungscode oder mit einem Familien-Passwort, das jemand aus der Familie vorher neu setzt.',
  // «Passwort vergessen?» — no e-mail, no reset: the three ways back
  'reset.title': 'Passwort vergessen?',
  'reset.noReset':
    'Die App kennt keine E-Mail-Adresse und keines deiner Passwörter – sie kann dir also kein neues schicken, und auch der Betreiber kann nichts zurücksetzen oder nachlesen. Dafür gibt es drei Wege zurück zu den Einträgen:',
  'reset.ownTitle': 'Persönliches Passwort vergessen',
  'reset.own':
    'Neues Konto mit neuem Benutzernamen erstellen und wieder beitreten: auf dem Anmeldebildschirm «Mit Wiederherstellungscode» – oder mit einem Familien-Passwort, das die andere Person vorher unter «Mehr › Konto» neu setzt (das alte ist seit dem letzten Beitritt verfallen). Alle Einträge bleiben erhalten.',
  'reset.familyTitle': 'Familien-Passwort vergessen oder verfallen',
  'reset.family':
    'Es gilt ohnehin nur für einen Beitritt. Wer schon in der Familie ist, braucht es nicht mehr und setzt unter «Mehr › Konto» jederzeit ein neues – frag einfach jemanden, der dabei ist.',
  'reset.allLostTitle': 'Alles verloren?',
  'reset.allLost':
    'Solange ein Gerät angemeldet ist, ist nichts verloren: Dort lässt sich unter «Mehr › Konto» ein neues Familien-Passwort setzen, der Code anzeigen oder alles als Datei exportieren. Fehlen alle drei Schlüssel und kein Gerät ist mehr angemeldet, sind die Einträge unwiederbringlich weg – niemand kann sie entschlüsseln.',
  'reset.nextTimeTitle': 'Für das nächste Mal',
  'reset.nextTime':
    'Benutzername und Passwort in den Passwort-Manager, den Wiederherstellungscode auf Papier. Das Familien-Passwort musst du dir nicht merken – es verfällt beim Beitritt.',
};
