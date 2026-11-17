// README.txt of the GDPR export archive (`dataExport.ts`).

export const ZIP_README = `markoto data export

This archive contains every piece of personal data markoto holds
about your account. It is produced under your right of access
(GDPR Article 15) and right to data portability (Article 20).

Contents:

  README.txt             this file
  profile.json           your account row (no password hash, no secrets)
  documents/             one Markdown file + one .meta.json per document
                         you own. Markdown is reconstructed from the
                         Y.js history of the doc; if the document has
                         no edits yet, the .md file is empty.
  comments.ndjson        every comment you authored, one JSON object per
                         line (NDJSON format).
  workspace_memberships.json  workspaces you are a member of, with role
                         and join date.
  workspace_invites.json  open workspace invitations addressed to your
                         email ("received") and ones you sent
                         ("sent": the address you typed, role, dates).
  themes.json            saved themes you've created.
  sso_identities.json    workspace identity providers (single sign-on)
                         your account is linked to.
  document_shares.json   documents shared with you as a workspace guest
                         ("received") and ones you shared with guests
                         ("granted"), with view / edit access.
  brand_assets.json      fonts and logos you uploaded to a workspace's
                         brand kit (the files stay with the workspace).
  published_pages.json   your documents published as web pages: address,
                         indexing, when (the page is your document's text).
  custom_domains.json    your custom domains, their check status and the
                         page each shows.
  ai/sessions.ndjson     AI sessions you initiated.
  ai/messages.ndjson     AI prompt + tool-call history (NDJSON).
  ai/edit-provenance.ndjson  which AI sessions you started on which
                         document, and whether their edits count as
                         your own text for the AI's safety checks.
  ai/usage.ndjson        per-billing-period AI interaction counters.
  ai/providers.json      your own AI provider settings (provider URL,
                         model, last verification). API keys are never
                         exported.
  activity.ndjson        activity-log rows attributed to you.
  audit.ndjson           audit-log rows actioned by you OR scoped to
                         your user id.
  consent.ndjson         every consent decision you have made.
  waitlist.ndjson        your paid-plans waitlist sign-up, if you joined
                         it while signed in (email, language, consent
                         version, sign-up + confirmation dates).
  ad_conversions.ndjson  if you arrived from a Google ad and then signed
                         up or created your first document: the ad's
                         click id, what it counted as, when, and when it
                         was reported to Google Ads (kept 90 days).
  abuse_reports.ndjson   reports you filed while signed in: what you
                         reported and wrote, your contact details,
                         the status, our decision and every notice we
                         sent you about it (confirmation, decision).
  moderation_notices.ndjson  statements of reasons we sent you when we
                         removed or restricted one of your documents.
  billing/customer.json  your Stripe customer record (if billing was
                         set up).
  billing/invoices.ndjson  your Stripe invoice history (if any).
  billing/workspace_subscriptions.json  Team / Business subscriptions of
                         workspaces you manage as billing admin (plan,
                         seats, status, currency, dates).
  billing/subscription_history.json  your Pro plan's history: started,
                         changed, cancellation scheduled or taken back,
                         ended (plan, period, currency, date).
  billing/ai_credits.json  AI credits you bought for yourself (pack,
                         credit, what's left, amount paid, expiry).

If a section is empty, the file still exists but contains zero rows.
`
