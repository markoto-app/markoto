---
title: Lock a document behind a password
description: Switch the access mode to password-protected, set a passphrase, and gate the share link behind it.
category: sharing
order: 1
featured: true
---

# Lock a document behind a password

By default, an anonymous markoto document is **open-edit** — anyone
with the link can read AND write. To gate access, switch the access
mode to *password-protected* and choose a passphrase. Visitors hit a
blocking dialog before the editor mounts; only the right passphrase
gets them past it.

This walkthrough sets a password on a logged-in user's document, then
simulates what a fresh visitor sees by clearing the doc-scoped cookie
and reloading. About thirty seconds. Works on desktop and mobile.

::flow{id="password-protect" hide-title}
::

## What just happened

Setting the password switched four things at once:

1. The token endpoint stopped issuing a usable Hocuspocus JWT for
   unverified visitors (`token: null`).
2. The Hocuspocus sync server rejects connections without a verified
   token.
3. The editor markup is hidden behind `v-if="!requiresPassword"` until
   the visitor enters the right passphrase.
4. The CodeMirror editor itself enters read-only state, just in case
   any of the above fail.

Three layers of defense in depth. The plaintext passphrase is **never
persisted** server-side — markoto stores only a scrypt hash. Past
visitors who already entered the password keep their cookie until it
expires (~2h) so they don't get re-prompted on every page load.

## What's next

- [Polish the doc and download a PDF](/docs/import-export/polished-pdf) — the password gate stays in place; the PDF link is gated too.
- [Have a discussion in your document](/docs/writing/comments) — invite collaborators, leave threaded comments.
