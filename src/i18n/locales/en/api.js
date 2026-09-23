// Server error messages by code (see de/api.js: the key is the code the
// server answers with; the first three are src/api.js's own).
export default {
  'network.offline': "You're offline – please check your internet connection",
  'network.unreachable': 'No connection to the server',
  'network.unexpected': 'Unexpected answer from the server ({status}) – please try again in a moment',
  'request.failed': 'Request failed ({status})',

  // the request itself (lib/http.php, index.php)
  'request.badJson': 'Invalid JSON body: {reason}',
  'request.badContentType': 'Invalid content type – JSON expected',
  'request.methodNotAllowed': 'Method not allowed',
  'request.notFound': 'Not found',
  'request.notAnInteger': '"{field}" must be a whole number',
  'request.missingField': '"{field}" is missing',
  'request.invalidField': '"{field}" is invalid',
  'request.badBlob': 'Invalid record',
  'request.writeBudget': 'Too many changes in a short time – please try again later',
  'server.busy': 'Briefly overloaded – please try again',
  'server.internal': 'Server error',

  // accounts and families (lib/auth.php)
  'auth.notLoggedIn': 'Not signed in',
  'auth.badCredentials': 'Wrong username or password',
  'auth.missingCredentials': 'Please enter your username and password',
  'auth.badKeyMaterial': 'Invalid key data',
  'auth.badUsername': 'Username: {min}–{max} characters – letters, digits, dot, dash or underscore',
  'auth.badFamilyName': 'Family name: {min}–{max} characters',
  'auth.badFamilyMode': 'Invalid request',
  'auth.missingFamilyCredential': 'Please enter the family password or the recovery code',
  'auth.badFamilyPassword': 'Wrong family password',
  'auth.badRecoveryCode': 'Invalid recovery code',
  'auth.familyUnknown': 'Family not found – please check the name',
  'auth.familyExists': 'This family was just created – please try again',
  'auth.usernameTaken': 'This username is already taken',
  'auth.badPassword': 'Wrong password',
  'auth.missingConfirmation': 'Please enter your password to confirm',
  'auth.throttled': 'Too many attempts – please try again later',

  // entries (lib/entries.php)
  'entries.badId': 'Invalid entry',
  'entries.exists': 'This entry already exists',
  'entries.notFound': 'Entry not found',
  'entries.conflict': 'This entry was changed on another device in the meantime',
  'entries.familyFull': 'The family\'s storage limit has been reached – no new entries possible',
  'entries.serverFull': 'The server is out of storage – no new entries possible',
};
