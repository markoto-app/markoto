---
title: Delete your account
description: 30-day grace period — you can cancel anytime in those 30 days. After the deadline, everything goes.
category: account
order: 5
featured: true
---

# Delete your account

GDPR Article 17 (right to erasure) says we have to delete your account
on request, "without undue delay". markoto's interpretation: 30 days
of grace. You hit Delete, you see exactly what'll happen, you confirm,
the account is scheduled. Any time in the next 30 days, one click
cancels and you're back to normal. Past the deadline, the account is
purged.

::flow{id="delete-account-with-consequences" hide-title}
::

## What just happened

Hitting Delete opened a confirmation modal that enumerates exactly
what's about to happen:

- **Deleted:** owned docs (incl. anonymous), saved themes, AI session
  history, your saved AI provider settings and keys, your MCP personal
  access tokens, queued data exports, and (where billing is on) your
  Stripe customer record.
- **Anonymised, not deleted:** your comments on other people's docs
  and your entries in activity and audit logs stay, shown as "Deleted
  user", so other people's history still makes sense.
- **Workspaces:** a workspace where you're the only member is deleted
  with you. Where you're an admin and others remain, the longest-standing
  other admin takes over; if there is none, the longest-standing editor
  (then viewer) becomes admin. Everywhere else you're simply removed as a
  member.

Confirming starts the 30-day countdown. A banner appears at the top of
the app showing the days remaining and a Cancel button. Cancelling
restores everything: your account is exactly as it was.

After the deadline passes, markoto purges the account automatically. On
instances with email set up you get a confirmation email when the deletion
completes.

## What's next

- [Export your data first](/docs/account/data-export) — once the deadline passes, you can't get it back.
- [Profile page](/docs/account) — where the Delete + Cancel buttons live.
