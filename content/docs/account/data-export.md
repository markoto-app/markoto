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

- `README.txt` describes every file.
- `profile.json`: your account details, without passwords or secrets.
- `documents/`: every document you own, as a Markdown file plus a `.meta.json` with its title, sharing settings and dates.
- `comments.ndjson`: every comment you wrote.
- `workspace_memberships.json` and `workspace_invites.json`: the workspaces you belong to, and the invitations you received or sent.
- `themes.json`: the themes you saved.
- `ai/`: your AI sessions, prompts and the AI's steps, plus your AI provider settings (never the key).
- `activity.ndjson` and `audit.ndjson`: your entries in the activity and audit logs.
- `consent.ndjson`: your cookie and analytics choices.
- `waitlist.ndjson`: your paid-plans waitlist sign-up, if any.
- `abuse_reports.ndjson`: reports you sent while signed in, with our decision and the emails we sent you about them.
- `moderation_notices.ndjson`: the explanations we sent you if we removed or restricted one of your documents.
- `billing/`: your billing records, empty where billing is off.

Files that would be empty are still included, so the layout is always the
same.

Your saved AI provider keys are never part of the export: they are stored
encrypted and only ever used by the server.

## What's next

- [Delete your account](/docs/account/delete-account) — once you've exported, you can wipe everything.
- [Profile page](/docs/account) — request more exports anytime; the history shows them all.
