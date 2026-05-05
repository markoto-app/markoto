---
title: Export all your data
description: Profile page → "Your data" → request export. ZIP arrives in minutes; download is good for 7 days.
category: account
order: 3
featured: true
---

# Export all your data

GDPR Article 15 (right of access) + Article 20 (data portability) say
the data we hold on you should be available to you in a structured,
commonly-used, machine-readable format. The Profile page → "Your
data" section requests exactly that — a ZIP with everything we know
about you and everything you've authored.

::flow{id="data-export" hide-title}
::

## What just happened

Requesting an export enqueues a row in `data_export_jobs` (`status:
queued`). A background worker drains the queue, calls `buildExportZip`,
uploads the resulting bytes to S3 under `exports/{userId}/{jobId}.zip`,
and flips the row to `ready` with a 7-day TTL on the download URL.

What's in the ZIP (13 standard entries):

1. `profile.json` — your account row, minus secrets
2. `workspaces.json` — workspaces you own + member of
3. `documents/<docId>/` — meta, current markdown, **full Y.js history reconstructed**
4. `comments.json` — your comments + comments others made on your docs
5. `activity-log.json` — your activity-feed contributions
6. `audit-log.json` — audit events where you were the actor
7. `knowledge-metadata.json` — workspace knowledge files you uploaded (metadata; the originals were deleted post-processing)
8. `consent-log.json` — your cookie/analytics consent decisions
9. `billing-snapshot.json` — your plan + period + usage stats
10. `README.md` — describes each entry

The download URL is presigned for 7 days; expiry sweeper marks the
row `expired` after that and best-effort deletes the S3 object.

## What's next

- [Delete your account](/docs/account/delete-account) — once you've exported, you can wipe everything.
- [Profile page](/docs/account) — request more exports anytime; the history shows them all.
