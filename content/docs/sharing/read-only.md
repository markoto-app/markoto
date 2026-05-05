---
title: Share as read-only
description: Switch the access mode to open-view — anyone with the link can read, nobody can edit.
category: sharing
order: 2
---

# Share as read-only

Sometimes you've drafted a doc and you want feedback (or eyeballs)
without the other person being able to change it. Open-view mode gives
exactly that: link-shareable, read-only, no signup, no password.

::flow{id="share-as-read-only" hide-title}
::

## What just happened

The share dialog sets `access_mode='open_view'` on the doc. The token
endpoint that mints the Hocuspocus JWT reads the access mode and
mints a `readOnly: true` token for any non-owner. Read-only is enforced
in four layers — the JWT, the Hocuspocus server, the CodeMirror
editable compartment, and the toolbar UI — so a determined client
can't write through any of them.

Workspace members override at the role level: an admin or editor on
the doc's workspace can still edit even if access mode is open-view.

## What's next

- [Lock the doc behind a password](/docs/sharing/password-protect) — when read-only isn't private enough.
- [Share by QR code](/docs/sharing/qr-code) — same link, different transport.
