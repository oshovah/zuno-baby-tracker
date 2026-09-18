// The login screen (views/login.js): login, register, recovery, unlock, the pitch.
export default {
  // Under the title, on every mode
  tagline: 'Nursing, bottles, diapers, sleep – for two, in sync and private.',
  // The pill above the login form that scrolls to the pitch
  pitchCue: 'What the app does',
  // The submit button while the phone derives the key (PBKDF2, ~0.3 s)
  kdfWorking: 'Computing the key …',
  'nav.backToLogin': 'Back to sign-in',

  // Field labels; the ⓘ button next to a label reads field.info
  'field.username': 'Username',
  'field.password': 'Password',
  'field.newUsername': 'New username',
  'field.newPassword': 'New password',
  'field.displayName': 'Display name',
  'field.otherName': 'other name',
  'field.family': 'Family',
  'field.familyPassword': 'Family password',
  'field.recoveryCode': 'Recovery code',
  'field.recoveryCodePlaceholder': '43 characters, e.g. Ab3d Ef5g …',
  'field.info': 'Info: {label}',
  'field.passphraseHint': 'At least {min} characters – best a short sentence of several words.',

  // Login
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in …',
  'login.createAccount': 'Create a new account',
  'login.forgotPassword': 'Forgot your password?',
  'login.withRecoveryCode': 'Use a recovery code',

  // Unlock: the cookie is alive, the key is gone from this device ({who} is escaped by the view)
  'unlock.hint': 'Signed in as <strong>{who}</strong>. This device is missing the key to the entries – please enter your password.',
  'unlock.why': 'Why?',
  'unlock.submit': 'Unlock',
  'unlock.submitting': 'Unlocking …',
  'unlock.otherAccount': 'Another account',

  // Register: create a family or join one
  'register.hint': 'Create an account and start a family – or join an existing one.',
  'register.howItWorks': 'How does it work?',
  'register.privacyTitle': '🔒 End-to-end encrypted.',
  'register.privacyBody': 'All entries are encrypted on your phone – nothing on the server is readable, not even by whoever runs it. No e-mail address, no phone number.',
  'register.privacyNoReset': 'That is why there is no "reset password" – remember your username and password well.',
  'register.privacyForgot': 'And if I forget it anyway?',
  // Under the family field: the live create-or-join check
  'register.familyHint': 'New name: you create the family. Known name: you join it with the family password.',
  'register.familyExists': '✓ "{name}" already exists – you are joining this family. You need its family password for that.',
  'register.familyNew': '"{name}" is new – you are creating this family. Choose a family password; the other parent joins with it later (then it expires).',
  'register.familyChecking': 'Checking …',
  'register.submit': 'Create account',
  'register.submitJoin': 'Join family',
  'register.submitCreate': 'Create family',
  'register.checkingFamily': 'Checking the family …',
  'register.joining': 'Joining …',
  'register.creating': 'Creating the family …',
  // After a join: the invite that let this phone in is spent
  'register.joinedClosed': 'Joined – the family password has now expired. Invite more people under More › Account.',

  // The recovery code shown once after a create ({family} is escaped by the view)
  'recoveryCode.title': 'Your recovery code',
  'recoveryCode.intro': 'The family "{family}" is set up. This code is the key to all entries – <strong>write it down now</strong>, on paper or in your password manager. Later you can find it any time under More › Account, after entering your password.',
  'recoveryCode.why': 'What for?',
  'recoveryCode.copy': 'Copy code',
  'recoveryCode.warning': 'Whoever has this code can read all entries – even without a password. So it belongs on paper or in a password manager, not in a chat.',
  'recoveryCode.confirm': 'I have written the code down',
  'recoveryCode.continue': 'Continue to the app',
  'recoveryCode.copied': 'Code copied – now store it safely',
  'recoveryCode.copyManually': 'Please copy the highlighted code',
  'recoveryCode.familyCreated': 'Family "{family}" created',
  'recoveryCode.adopted.one': '{n} existing entry taken over',
  'recoveryCode.adopted.other': '{n} existing entries taken over',

  // A new account in an existing family via the recovery code
  'recovery.hint': 'With the recovery code you create a new account in your family – without a password. All entries are kept.',
  'recovery.more': 'Learn more',
  'recovery.submit': 'Create account',
  'recovery.submitting': 'Creating the account …',
  'recovery.welcomeBack': 'Welcome back to "{family}"',

  // Inline validation and the errors the screen raises itself
  'error.noUsername': 'Please enter your username',
  'error.noPassword': 'Please enter your password',
  'error.chooseUsername': 'Please choose a username',
  'error.passwordShort': 'The password needs at least {min} characters',
  'error.chooseDisplayName': 'Please choose a display name',
  'error.noFamilyName': 'Please enter a family name',
  'error.noFamilyNameRecovery': 'Please enter the family name',
  'error.noFamilyPassword': 'Please enter the family password',
  'error.familyPasswordShort': 'The family password needs at least {min} characters',
  'error.noRecoveryCode': 'Please enter the recovery code',
  'error.sessionGone': 'Session expired – please sign in again',
  'error.familyCheck': 'The family name could not be checked – please try again',

  // The pitch under the login form: six features, the CTA
  'pitch.title': 'Built for two phones',
  'pitch.lead': 'One baby, two parents, one shared picture – and nobody looking over your shoulder.',
  'pitch.sync.title': 'Start on one phone, stop on the other.',
  'pitch.sync.body': 'Nursing, sleep and every diaper show up on both phones right away. Whoever takes over sees when the last meal was and which side is next.',
  'pitch.e2ee.title': 'End-to-end encrypted.',
  'pitch.e2ee.body': 'Entries only ever leave the phone encrypted – nothing on the server is readable, not even by whoever runs it. No e-mail address, no ads, no tracking.',
  'pitch.oneTap.title': 'One tap, even at three in the morning.',
  'pitch.oneTap.body': 'Nursing left or right, bottle, diaper, sleep: tap once, done. Started the timer too late? Five minutes back – one more tap.',
  'pitch.midwife.title': "The midwife's questions.",
  'pitch.midwife.body': 'Awake for how long, when the last meal was, how many wet and soiled diapers today – all at a glance. Plus History, Log and an export.',
  'pitch.reminders.title': 'Reminders both of you see.',
  'pitch.reminders.body': 'Vitamin D at six, Mom\'s pill in the morning: set it up once, and "Now" shows what is still open today. One tap ticks it off – on the other phone it is done too.',
  'pitch.noStore.title': 'No app store.',
  'pitch.noStore.body': 'Open it in the browser, "Add to Home Screen" – runs on iPhone and Android like an app.',
  'pitch.cta': 'Create account',
  'pitch.ctaNote': 'No e-mail address, set up in a minute. The other parent joins with the family name and the family password.',

  // "Why this app exists" — the maker's note under the pitch
  'about.title': 'Why this app exists',
  'about.p1': 'Our baby arrived, and with it the questions: When was the last meal? Which side? How many diapers today? The apps for that wanted an account, an e-mail, a subscription – and could read everything. So I built the app myself.',
  'about.p2': 'Every feature here exists because I needed it in exactly that moment: the stop button for nursing, the feeding amount for the bottle, the pause for burping, the reminder for the vitamin D. Nothing was added because other apps have it too – everything because we were missing it at home.',
  'about.p3': 'I am a developer – but with a baby on one arm, typing is hard. So I built the app together with Claude: by remote control from my phone, while waiting at the hospital and later in the postpartum weeks, between two meals. I said what was missing, Claude wrote, I checked. The app came about the way it is used: one-handed.',
  'about.tech': 'Tech: vanilla JavaScript with Vite, as an installable web app with a service worker. Behind it a small PHP API with SQLite on Swiss shared hosting. Encryption runs in the browser (WebCrypto, AES-GCM); the family key is derived from the password and never leaves the phone.',
};
