---
title: Share by QR code
description: Generate a QR code for the doc URL — paste it in a slide deck, project it on a screen, scan it from a phone.
category: sharing
order: 3
---

# Share by QR code

When the people you want to share with are in the room — talk
attendees, classroom, workshop — typing a URL is friction. The share
dialog has a QR code generator that encodes the current doc link.
Scan, open.

::flow{id="share-by-qr-code" hide-title}
::

## What just happened

The QR code is generated client-side from the same URL the Copy Link
button hands you. Whatever access mode the doc is in (private,
open-edit, open-view, password-protected) applies to the QR-scanned
link the same way — the QR code doesn't bypass anything.

If you flip the doc to password-protected after generating the QR
code, scanners hit the password gate exactly like any other visitor
would. Old QR images don't carry old permissions.

## What's next

- [Share read-only](/docs/sharing/read-only) — pair "view, don't edit" with the QR for a presentation-friendly link.
- [Lock with a password](/docs/sharing/password-protect) — when you want both QR-easy AND gated.
