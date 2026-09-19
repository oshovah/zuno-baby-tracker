// The login screen (views/login.js): login, register, recovery, unlock, the pitch.
export default {
  // Under the title of the login mode: what it is, then (taglineTrust, its
  // own line) why to trust it — the short form of the hosting panel below
  tagline: 'Stillen, Schoppen, Windeln, Schlaf – zu zweit, synchron und privat.',
  taglineTrust: 'Verschlüsselt. In der Schweiz gehostet. Ohne Dritte.',
  // The pill above the login form that scrolls to the pitch
  pitchCue: 'Was die App kann',
  // The submit button while the phone derives the key (PBKDF2, ~0.3 s)
  kdfWorking: 'Schlüssel wird berechnet …',
  'nav.backToLogin': 'Zurück zur Anmeldung',

  // Field labels; the ⓘ button next to a label reads field.info
  'field.username': 'Benutzername',
  'field.password': 'Passwort',
  'field.newUsername': 'Neuer Benutzername',
  'field.newPassword': 'Neues Passwort',
  'field.displayName': 'Anzeigename',
  'field.otherName': 'anderer Name',
  'field.family': 'Familie',
  'field.familyPassword': 'Familien-Passwort',
  'field.recoveryCode': 'Wiederherstellungscode',
  'field.recoveryCodePlaceholder': '43 Zeichen, z. B. Ab3d Ef5g …',
  'field.info': 'Info: {label}',
  'field.passphraseHint': 'Mindestens {min} Zeichen – am besten ein kurzer Satz aus mehreren Wörtern.',

  // Login
  'login.submit': 'Anmelden',
  'login.submitting': 'Anmelden …',
  'login.createAccount': 'Neues Konto erstellen',
  'login.forgotPassword': 'Passwort vergessen?',
  'login.withRecoveryCode': 'Mit Wiederherstellungscode',

  // Unlock: the cookie is alive, the key is gone from this device ({who} is escaped by the view)
  'unlock.hint': 'Angemeldet als <strong>{who}</strong>. Auf diesem Gerät fehlt der Schlüssel zu den Einträgen – bitte dein Passwort eingeben.',
  'unlock.why': 'Warum?',
  'unlock.submit': 'Entsperren',
  'unlock.submitting': 'Entsperren …',
  'unlock.otherAccount': 'Anderes Konto',

  // Register: create a family or join one
  'register.hint': 'Konto erstellen und eine Familie anlegen – oder einer bestehenden beitreten.',
  'register.howItWorks': 'Wie funktioniert das?',
  'register.privacyTitle': '🔒 Ende-zu-Ende verschlüsselt.',
  'register.privacyBody': 'Alle Einträge werden auf deinem Handy verschlüsselt – auf dem Server ist nichts lesbar, auch nicht für den Betreiber. Keine E-Mail-Adresse, keine Telefonnummer.',
  'register.privacyNoReset': 'Darum gibt es kein «Passwort zurücksetzen» – merk dir Benutzername und Passwort gut.',
  'register.privacyForgot': 'Und wenn ich es doch vergesse?',
  // Under the family field: the live create-or-join check
  'register.familyHint': 'Neuer Name: Du legst die Familie an. Bekannter Name: Du trittst ihr mit dem Familien-Passwort bei.',
  'register.familyExists': '✓ «{name}» gibt es schon – du trittst dieser Familie bei. Dafür brauchst du ihr Familien-Passwort.',
  'register.familyNew': '«{name}» ist neu – du legst diese Familie an. Wähle ein Familien-Passwort; damit tritt der zweite Elternteil später bei (danach verfällt es).',
  'register.familyChecking': 'Wird geprüft …',
  'register.submit': 'Konto erstellen',
  'register.submitJoin': 'Familie beitreten',
  'register.submitCreate': 'Familie anlegen',
  'register.checkingFamily': 'Familie wird geprüft …',
  'register.joining': 'Beitreten …',
  'register.creating': 'Familie wird angelegt …',
  // After a join: the invite that let this phone in is spent
  'register.joinedClosed': 'Beigetreten – das Familien-Passwort ist damit verfallen. Weitere Personen lädst du unter Mehr › Konto ein.',

  // The recovery code shown once after a create ({family} is escaped by the view)
  'recoveryCode.title': 'Dein Wiederherstellungscode',
  'recoveryCode.intro': 'Die Familie «{family}» ist angelegt. Dieser Code ist der Schlüssel zu allen Einträgen – <strong>schreib ihn jetzt auf</strong>, auf Papier oder in den Passwort-Manager. Später findest du ihn jederzeit unter «Mehr › Konto», nach Eingabe deines Passworts.',
  'recoveryCode.why': 'Wozu?',
  'recoveryCode.copy': 'Code kopieren',
  'recoveryCode.warning': 'Wer diesen Code hat, kommt an alle Einträge – auch ohne Passwort. Darum gehört er auf Papier oder in den Passwort-Manager, nicht in einen Chat.',
  'recoveryCode.confirm': 'Ich habe den Code notiert',
  'recoveryCode.continue': 'Weiter zur App',
  'recoveryCode.copied': 'Code kopiert – jetzt sicher ablegen',
  'recoveryCode.copyManually': 'Bitte den markierten Code kopieren',
  'recoveryCode.familyCreated': 'Familie «{family}» angelegt',

  // A new account in an existing family via the recovery code
  'recovery.hint': 'Mit dem Wiederherstellungscode legst du ein neues Konto in eurer Familie an – ohne Passwort. Alle Einträge bleiben erhalten.',
  'recovery.more': 'Mehr dazu',
  'recovery.submit': 'Konto anlegen',
  'recovery.submitting': 'Konto wird angelegt …',
  'recovery.welcomeBack': 'Willkommen zurück bei «{family}»',

  // Inline validation and the errors the screen raises itself
  'error.noUsername': 'Bitte Benutzername angeben',
  'error.noPassword': 'Bitte Passwort angeben',
  'error.chooseUsername': 'Bitte einen Benutzernamen wählen',
  'error.passwordShort': 'Das Passwort braucht mindestens {min} Zeichen',
  'error.chooseDisplayName': 'Bitte einen Anzeigenamen wählen',
  'error.noFamilyName': 'Bitte einen Familiennamen angeben',
  'error.noFamilyNameRecovery': 'Bitte den Familiennamen angeben',
  'error.noFamilyPassword': 'Bitte das Familien-Passwort angeben',
  'error.familyPasswordShort': 'Das Familien-Passwort braucht mindestens {min} Zeichen',
  'error.noRecoveryCode': 'Bitte den Wiederherstellungscode eingeben',
  'error.sessionGone': 'Anmeldung abgelaufen – bitte neu anmelden',
  'error.familyCheck': 'Der Familienname konnte nicht geprüft werden – bitte nochmals versuchen',

  // The pitch under the login form: six features, the CTA
  'pitch.title': 'Für zwei Handys gebaut',
  'pitch.lead': 'Ein Baby, zwei Eltern, ein gemeinsamer Stand – ohne dass irgendwer mitliest.',
  'pitch.sync.title': 'Auf dem einen starten, auf dem anderen stoppen.',
  'pitch.sync.body': 'Stillen, Schlaf und jede Windel sind sofort auf beiden Handys. Wer übernimmt, sieht, wann die letzte Mahlzeit war und welche Seite dran ist.',
  'pitch.e2ee.title': 'Ende-zu-Ende verschlüsselt.',
  'pitch.e2ee.body': 'Einträge verlassen das Handy nur verschlüsselt – auf dem Server ist nichts lesbar, auch nicht für den Betreiber. Keine E-Mail-Adresse, keine Werbung, kein Tracking.',
  'pitch.oneTap.title': 'Ein Fingertipp, auch um drei Uhr nachts.',
  'pitch.oneTap.body': 'Stillen links oder rechts, Schoppen, Windel, Schlaf: einmal antippen, fertig. Timer zu spät gestartet? Fünf Minuten zurück – noch ein Fingertipp.',
  'pitch.midwife.title': 'Die Fragen der Hebamme.',
  'pitch.midwife.body': 'Seit wann wach, wann die letzte Mahlzeit, wie viele nasse und volle Windeln heute – alles auf einen Blick. Dazu der Verlauf, Nachtragen und ein Export.',
  'pitch.reminders.title': 'Erinnerungen, die beide sehen.',
  'pitch.reminders.body': 'Vitamin D um sechs, Mamas Tablette am Morgen: einmal anlegen, und «Jetzt» zeigt, was heute noch offen ist. Ein Fingertipp hakt ab – auf dem anderen Handy ist es auch erledigt.',
  'pitch.noStore.title': 'Ohne App-Store.',
  'pitch.noStore.body': 'Im Browser öffnen, «Zum Home-Bildschirm» – läuft auf iPhone und Android wie eine App.',
  'pitch.cta': 'Konto erstellen',
  'pitch.ctaNote': 'Ohne E-Mail-Adresse, in einer Minute eingerichtet. Der zweite Elternteil tritt mit Familienname und Familien-Passwort bei.',

  // The screenshot strip under the pitch's lead (src/shots.js lists the
  // screens): one caption per picture — plain text, it is the alt text too —,
  // the strip's and the dots' labels for screen readers, the note underneath
  'shots.label': 'Bildschirmfotos der App',
  'shots.home': '«Jetzt»: wann die letzte Mahlzeit war, welche Seite dran ist, was heute noch ansteht.',
  'shots.timer': 'Stillen läuft: Pause zum Aufstossen, ein Fingertipp beendet.',
  'shots.bottle': 'Schoppen: Die Trinkmenge fürs Alter steht schon da – was gestillt wurde, ist abgezogen.',
  'shots.history': '«Verlauf»: jeder Tag mit seinen Zahlen – und wer was eingetragen hat.',
  'shots.charts': '«Grafik»: Gewicht, Mahlzeiten, Windeln und Schlaf über die Tage.',
  'shots.dot': 'Bild {n} von {total}',
  'shots.note': 'Echte Bildschirme der App – die Daten darin sind erfunden.',

  // «Wo eure Daten liegen» — the panel between the features and the CTA:
  // the drawing's three labels, where THIS installation runs ({host} = the
  // hoster's name as a link, {name} = the same as text; both come from the
  // view, the place is written here), and what is missing on purpose (tags).
  // Only claim what the packaged CSP (scripts/package.mjs) really enforces.
  'hosting.title': 'Ein Server in der Schweiz&nbsp;– sonst nichts.',
  'hosting.map.phone': 'Dein Handy',
  'hosting.map.server': '{name}, Basel',
  'hosting.map.partner': 'Das zweite Handy',
  'hosting.where': 'Zuno läuft vollständig bei {host} in Basel: Die App und die Datenbank mit euren verschlüsselten Einträgen liegen auf Servern in der Schweiz.',
  'hosting.only': 'Dein Handy spricht nur mit diesem einen Server – auch Schriften, Skripte und Bilder kommen von dort. Kein Dienst, kein Tool und kein CDN von Dritten: nichts ausserhalb des Hostings bei {name}.',
  'hosting.noneTitle': 'Was hier fehlt – mit Absicht:',
  'hosting.none.cdn': 'CDN',
  'hosting.none.fonts': 'Google Fonts',
  'hosting.none.analytics': 'Analyse-Tools',
  'hosting.none.ads': 'Werbenetze',
  'hosting.none.login': 'Login über Google oder Apple',
  'hosting.none.ai': 'KI-Dienste',
  'hosting.proof': 'Dein Browser setzt das durch: Die Seite verbietet ihm jede Verbindung zu einer anderen Adresse (Content-Security-Policy).',
  // … and the way to check all of it: {link} = hosting.sourceLink as a link to the public repository
  'hosting.source': 'Glauben musst du das nicht: Der ganze Quellcode ist öffentlich – {link}.',
  'hosting.sourceLink': 'auf GitHub nachlesen',

  // «Warum es diese App gibt» — the maker's note under the pitch
  'about.title': 'Warum es diese App gibt',
  'about.p1': 'Unser Baby kam, und mit ihm die Fragen: Wann war die letzte Mahlzeit? Welche Seite? Wie viele Windeln heute? Die Apps dafür wollten ein Konto, eine E-Mail, ein Abo – und lasen mit. Also habe ich mir die App selber gebaut.',
  'about.p2': 'Jede Funktion hier gibt es, weil ich sie in genau dem Moment gebraucht habe: der Stopp-Knopf für das Stillen, die Trinkmenge für den Schoppen, die Pause zum Aufstossen, die Erinnerung an das Vitamin D. Nichts ist dazugekommen, weil es in anderen Apps auch drin ist – alles, weil es bei uns zu Hause gefehlt hat.',
  'about.p3': 'Ich bin Entwickler – aber mit einem Baby auf dem einen Arm tippt es sich schlecht. Darum habe ich die App zusammen mit Claude gebaut: per Fernsteuerung vom Handy aus, in den Wartezeiten im Spital und später im Wochenbett, zwischen zwei Mahlzeiten. Ich habe gesagt, was fehlt, Claude hat geschrieben, ich habe geprüft. Die App ist so entstanden, wie sie benutzt wird: einhändig.',
  'about.tech': 'Technik: Vanilla JavaScript mit Vite, als installierbare Web-App mit Service Worker. Dahinter eine kleine PHP-API mit SQLite auf einem Shared Hosting bei cyon in Basel. Die Verschlüsselung läuft im Browser (WebCrypto, AES-GCM), der Familienschlüssel wird aus dem Passwort abgeleitet und verlässt das Handy nie.',
  // The tech note's last sentence: {link} = the repository's address, as a link
  'about.source': 'Der Quellcode ist offen (AGPL-3.0): {link}',
};
