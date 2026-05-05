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

- **Deleted:** owned docs (incl. anonymous), saved themes, AI usage
  history, queued data exports, your Stripe customer record.
- **Anonymised, not deleted:** comments on other people's docs
  (collaboration history doesn't tear holes), activity-log
  attribution, audit-log actor, consent-log entries — all flip to
  "Deleted user" / null FK so the historical record stays readable.
- **Workspace fates:** sole-member workspaces cascade-delete with
  you; multi-member workspaces where you're the only admin promote
  the longest-tenured other admin to owner before removing your
  membership; everywhere else, you're just removed as a member.

Confirming flips `users.deletion_requested_at = now()` and starts
the 30-day countdown. A banner appears at the top of the app
showing the days remaining + a Cancel button. The cancel restores
all state — the column nulls, the audit row records the cancel,
and your account is exactly as it was.

After the deadline passes, the `account-deletion-sweep` plugin
claims your row and runs the 10-step purge through
`accountDeletionExecute.ts`. You get a transactional email when
the deletion completes.

## What's next

- [Export your data first](/docs/account/data-export) — once the deadline passes, you can't get it back.
- [Profile page](/docs/account) — where the Delete + Cancel buttons live.
