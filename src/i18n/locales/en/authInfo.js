// The ⓘ sheets of the login screen (views/auth-info.js): one key per title,
// per paragraph and per list item. The block structure (paragraphs, lists,
// sub-headings) lives in the view; only inline HTML (<strong>, <br />) is
// allowed here — the strings land in innerHTML.
export default {
  // "Three keys" — the block the reset sheet shares
  'threeKeys.title': 'Three keys',
  'threeKeys.own': '<strong>Your password</strong> – unlocks the entries on your devices.',
  'threeKeys.family':
    '<strong>The family password</strong> – only needed to join the family, and good for exactly one join: after that it expires. Whoever wants to invite someone sets a new one under More › Account.',
  'threeKeys.recovery':
    '<strong>The recovery code</strong> – shown when the family is created (and again later under More › Account). It opens the entries without any password.',
  // "How does this work?" on the registration form
  'howto.title': 'How registration works',
  'howto.whatIsFamily':
    'A family is everyone who tracks the same baby – usually Mom and Dad. Everyone in the family sees the same entries and timers.',
  'howto.stepCreate':
    '<strong>The first person creates the family:</strong> create an account, type a new family name, choose a family password. The app then shows the recovery code – write it down.',
  'howto.stepJoin':
    '<strong>The second person joins:</strong> create their own account, enter the same family name and the family password. That closes the door – the family password expires with the join.',
  'howto.stepDone':
    '<strong>Done.</strong> Both phones show the same entries; a timer started on one can be stopped on the other.',
  'howto.moreMembers':
    'Someone else (grandparents, a nanny)? A member sets a new family password under More › Account and passes it on – after the join, that one expires too.',
  'howto.nameCheck': 'Whether a family name already exists shows right under the field as you type.',
  'howto.privacyTitle': 'Privacy',
  'howto.privacy':
    'The server holds only usernames and family names. Every entry, every time, every amount and your display name are encrypted on the phone before they leave it. The key is derived from your password – whoever runs the app can neither read your entries nor reset a password. No e-mail address, no phone number.',
  // ⓘ next to the username field
  'username.title': 'Username',
  'username.purpose': 'Your name for signing in – others never see it, entries show the display name.',
  'username.rules':
    '2 to 30 characters (letters, digits, dot, dash, underscore), case does not matter. It must be unique across the whole app: "mom" is probably taken, "linas.mom" or "anna.k" probably not.',
  'username.remember': '<strong>Remember it</strong> – there is no e-mail address it could be sent to.',
  // ⓘ next to the password field
  'password.title': 'Password',
  'password.purpose':
    'Your personal password, at least 8 characters – each person in the family has their own. A short phrase of three or four words works best.',
  'password.neverLeaves':
    'It never leaves your phone: the key that decrypts the entries is derived from it. The server only sees a checksum – which is why there is no "reset password" link. Best saved in the phone\'s password manager.',
  'password.forgotten':
    'Forgot it anyway? Then create a new account with a new username and join again – with the recovery code, or with a family password the other person sets fresh under More › Account first. All entries are kept.',
  // ⓘ next to the display-name field
  'displayName.title': 'Display name',
  'displayName.purpose':
    'How you appear on entries, for example "Diaper · Mom". Free to choose and encrypted like the entries – the server does not know it.',
  'displayName.change':
    'Can be changed any time under More › Account; earlier entries keep the name they were logged under.',
  // ⓘ next to the family-name field
  'family.title': 'Family',
  'family.purpose':
    "Your family's name – free to choose, for example the surname or the baby's name. Case does not matter.",
  'family.newOrExisting':
    '<strong>New name:</strong> you create the family and choose its family password.<br /><strong>Existing name:</strong> you join – with the family password someone in the family gave you.',
  'family.scope': 'Everyone in the family sees and edits everything. Other families see nothing.',
  // ⓘ next to the family-password field
  'familyPassword.title': 'Family password',
  'familyPassword.purpose': "Your family's invitation key, at least 8 characters – not your personal password.",
  'familyPassword.oneTime':
    'Whoever creates the family chooses it. Whoever joins enters it together with the family name and receives the key to the entries with it – and with the join it expires: after that nobody can use it any more, even someone who knows it. Only give it to people who may see all entries.',
  'familyPassword.nextPerson':
    '<strong>Someone else?</strong> Anyone already in the family sets a new one under More › Account and passes it on. If nobody is signed in any more, the recovery code helps.',
  // "What for?" / "More about this" on the recovery form
  'recovery.title': 'Recovery code',
  'recovery.what':
    'The 43-character code the app showed when the family was created. It is the key to all entries – whoever has it can read everything. So it belongs on paper or in the password manager, not in a chat message.',
  'recovery.use':
    'With it you create a new account in your family here – without any password. All entries are kept, the old account is simply left behind, and the code stays valid.',
  'recovery.format':
    'Case matters; the spaces between the blocks can be left out. Anyone signed in finds the code under More › Account after entering their own password.',
  // "Why?" on the unlock screen
  'unlock.title': 'Why the password again?',
  'unlock.why':
    'You are still signed in, but this device is missing the key to the entries – that happens when the browser cleared website data or the phone freed up storage.',
  'unlock.what':
    'From your password the app derives the key again and stores it back on the device. Nothing that would make the entries readable is sent to the server.',
  'unlock.forgotten':
    'Forgot your password? Create a new account via "Another account" and join again – with the recovery code, or with a family password someone in the family sets fresh first.',
  // "Forgot password?" — no e-mail, no reset: the three ways back
  'reset.title': 'Forgot your password?',
  'reset.noReset':
    'The app has no e-mail address and none of your passwords – so it cannot send you a new one, and whoever runs it cannot reset or look anything up either. Instead there are three ways back to the entries:',
  'reset.ownTitle': 'Forgot your personal password',
  'reset.own':
    'Create a new account with a new username and join again: on the sign-in screen, "Use a recovery code" – or with a family password the other person sets fresh under More › Account first (the old one expired with the last join). All entries are kept.',
  'reset.familyTitle': 'Family password forgotten or expired',
  'reset.family':
    'It is only good for one join anyway. Anyone already in the family no longer needs it and can set a new one under More › Account at any time – just ask someone who is in.',
  'reset.allLostTitle': 'Everything lost?',
  'reset.allLost':
    'As long as one device is signed in, nothing is lost: there you can set a new family password under More › Account, show the code or export everything as a file. If all three keys are missing and no device is signed in any more, the entries are gone for good – nobody can decrypt them.',
  'reset.nextTimeTitle': 'For next time',
  'reset.nextTime':
    'Username and password in the password manager, the recovery code on paper. You do not need to remember the family password – it expires with the join.',
};
