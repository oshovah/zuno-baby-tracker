// Physical buttons: the section under More › Settings (for the family) and
// the sheet that adds, shows and removes one (src/device-sheet.js).
export default {
  // the section under Settings › For the family
  'section.title': 'Analog buttons',
  'section.hint':
    'Real buttons next to the changing table: a small device with up to three push buttons – a microcontroller with Wi-Fi, the {guide} ships with the source code – logs a diaper with one press (pee, poop or both), without anyone picking up a phone. Every press is encrypted on the device; the server only sees that a button was pressed. The next phone that syncs turns it into the entry – with the device\'s name.',
  // The link in the hint (lands in innerHTML through the {guide} param)
  'section.guide': 'build guide',
  'section.empty': 'No button device set up yet.',
  'section.add': 'Add analog buttons',
  // a row in the list: the name, the day it was set up
  'section.since': 'since {day}',
  'section.open': 'Code and settings',

  // the add form
  'add.title': 'Add analog buttons',
  'add.intro': 'Give the device a name – it is written on every entry it makes. A device has up to three buttons (pee, poop, both); which button logs what is set in its program. The app then shows the code that goes in there.',
  'add.nameLabel': 'Name',
  'add.namePlaceholder': 'e.g. Changing table',
  'add.submit': 'Create device',
  'add.working': 'Creating …',
  'add.done': 'Device "{name}" created',
  'defaultName': 'Changing table',

  // the detail view: the code, the test press, removal
  'detail.title': 'Analog buttons',
  'detail.meta': '{name} · set up: {day}',
  'detail.codeLabel': 'The code for the device',
  'detail.codeHint':
    'Put it into the device\'s program (ZUNO_CODE), together with Zuno\'s address and the Wi-Fi. The code contains the key the device encrypts with – only the device and the family\'s phones know it, the server does not. Whoever has it can make entries: do not pass it on. The program also says which button logs what (pee, poop, both).',
  'detail.copy': 'Copy code',
  'detail.copied': 'Code copied',
  'detail.copyFailed': 'Copying not possible – please select the code and copy it',
  'detail.sketch': 'Build guide and program',
  'detail.test': 'Send a test press',
  'detail.testHint': 'Sends one press exactly as the device would – a wet diaper, now. After the next sync the entry is in History; it can be deleted there.',
  'detail.testing': 'Sending …',
  'detail.tested': 'Test press sent – the entry arrives with the next sync',
  'detail.remove': 'Remove device',
  'detail.removeConfirm': 'Really remove?',
  'detail.removeHint': 'The device\'s code stops working; its entries stay.',
  'detail.removing': 'Removing …',
  'detail.removed': 'Device "{name}" removed',
  'detail.gone': 'Device not found',
};
