---
title: Export all your data
description: Profile page → "Your data" → request export. ZIP arrives in minutes; download is good for 7 days.
category: account
order: 2
updated: '2026-11-04'
---

# Export all your data

GDPR Article 15 (right of access) and Article 20 (data portability) give
you the right to receive the data we hold on you in a structured,
commonly used, machine-readable format. The "Your data" section of the
Profile page requests exactly that: a ZIP with everything we know about
you and everything you've written.

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
- `document_shares.json`, `sso_identities.json` and `brand_assets.json`: documents shared with you or by you as a guest share, the single sign-on connections your account is linked to, and the brand fonts and logos you uploaded to a workspace (the files stay with the workspace).
- `published_pages.json` and `custom_domains.json`: your documents published as web pages, and your custom domains.
- `imports.json`: the imports you started in the last 30 days (source, outcome, and per file its path and the document it became; file contents are not kept).
- `ai/`: your AI sessions, prompts and the AI's steps, which AI sessions you started on which document, your large background AI edits (`jobs.ndjson`), plus your AI provider settings (never the key).
- `activity.ndjson` and `audit.ndjson`: your entries in the activity and audit logs.
- `consent.ndjson`: the consent decisions recorded for your account. markoto has no cookie banner, so in practice this holds only older records from the banner we used to show.
- `ad_conversions.ndjson`: if you arrived from a Google ad and then signed up, joined the waitlist or created your first document: the ad's click identifier, which step it counted as and when (kept 90 days).
- `waitlist.ndjson`: your paid-plans waitlist sign-up, if any.
- `abuse_reports.ndjson`: reports you sent while signed in, with our decision and the emails we sent you about them.
- `moderation_notices.ndjson`: the explanations we sent you if we removed or restricted one of your documents.
- `billing/`: your billing records (customer, invoices, AI credits you bought, subscription history and workspace subscriptions you manage), empty where billing is off.

Files that would be empty are still included, so the layout is always the
same.

Your saved AI provider keys are never part of the export: they are stored
encrypted and only ever used by the server.

## What's next

- [Delete your account](/docs/account/delete-account): once you've exported, you can wipe everything.
- [Profile page](/docs/account): request more exports anytime; the history shows them all.
