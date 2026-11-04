---
title: Lock a document behind a password
description: Switch the access mode to password-protected, set a passphrase, and gate the share link behind it.
category: sharing
order: 1
featured: true
updated: '2026-10-29'
---

# Lock a document behind a password

By default, a new markoto document is **open-edit**: anyone with the
link can read and write. As the document's owner you can lock it: switch
the access mode to *password-protected* and choose a password of at
least 8 characters. Visitors see a password prompt before the document
opens; only the right password gets them in. (Anonymous documents have
no owner, so they can't be locked; sign in before you create a document
you want to protect.)

This walkthrough sets a password on a signed-in user's document, then
opens the link in a second browser to show what a visitor sees. About
thirty seconds. Works on desktop and mobile.

::flow{id="password-protect" hide-title}
::

## What just happened

Until a visitor enters the password, markoto doesn't send them the
document at all, neither the text nor live edits, so there is nothing to
reveal by poking at the page. The password itself is never stored, only
a one-way hash of it. A visitor who entered it stays unlocked for up to
two hours, so they aren't asked again on every page load. Changing the
password or the access mode applies to new visits right away; someone who
already unlocked the document keeps access until those two hours are up.

Repeated wrong guesses are slowed down and, after too many failures, the
password check pauses for a while.

## What's next

- [Polish the doc and download a PDF](/docs/import-export/polished-pdf) — the password gate stays in place; the PDF link is gated too.
- [Have a discussion in your document](/docs/writing/comments) — invite collaborators, leave threaded comments.
