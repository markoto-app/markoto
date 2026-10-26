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

Requesting an export queues a job. A background worker builds the ZIP,
stores it, and the profile page shows a download link once it is ready
(and an email goes out if the instance has email set up; otherwise the
profile page is the place to look). The link works for 7 days, after which
the file is deleted and you can request a new export.

What's in the ZIP:

1. `profile.json` — your account row, minus secrets
2. `workspaces.json` — workspaces you own + member of
3. `documents/<docId>/` — meta, current markdown, **full Y.js history reconstructed**
4. `comments.json` — your comments + comments others made on your docs
5. `activity-log.json` — your activity-feed contributions
6. `audit-log.json` — audit events where you were the actor
7. `knowledge-metadata.json` — workspace knowledge files you uploaded (metadata; the originals were deleted post-processing)
8. `consent-log.json` — your cookie/analytics consent decisions
9. `billing-snapshot.json` — your plan and billing period (empty where billing is off)
10. `README.md` — describes each entry

Your saved AI provider keys are never part of the export: they are stored
encrypted and only ever used by the server.

## What's next

- [Delete your account](/docs/account/delete-account) — once you've exported, you can wipe everything.
- [Profile page](/docs/account) — request more exports anytime; the history shows them all.
