# Security policy

Baby Tracker makes one promise: the server cannot read a family's entries.
If you find a way to break that promise — or any other vulnerability — please
report it privately first.

## Reporting

Use GitHub's private vulnerability reporting: **Security › Report a
vulnerability** on this repository. Please do not open a public issue for
anything exploitable.

This is a spare-time project run by one parent; expect an answer within a few
days, not hours.

## Scope

In scope:

- the client crypto and key handling (`src/crypto.js`, `src/session.js`,
  `src/keys.js`, `src/store.js`)
- the API: auth values, throttling, family isolation, the sync cursor (`api/`)
- the packaged security headers and the service worker
  (`scripts/package.mjs`, `public/sw.js`)

Out of scope: attacks that need a compromised phone, browser or browser
extension; denial of service against one deployment; and the limits the
README states openly (whoever controls the server could ship a modified
client).

Please do not test against a deployment that is not yours. `npm run dev`
gives you a full local instance in a minute — see the README.
