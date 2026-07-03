---
slug: privacy
locale: en
version: 3
effectiveDate: 2026-05-06
translationStatus: authoritative
---

# Privacy Policy

> **In short:** markoto stores the documents you write, the comments you leave, and the minimum we need to bill you. AI features run on EU-resident providers (Mistral AI for text and voice, Jina AI for embeddings and single-page fetching, Staan for web search, Black Forest Labs for image generation); payments go through Stripe. We don't sell your data, we don't run ads, and we don't train AI on your content. You can export everything we hold about you and delete your account at any time from your settings.

---

## 1. Who we are

markoto is operated by **{{controllerName}}** ({{controllerAddress}}). For any privacy question, write to **{{privacyContactEmail}}**.

For the purposes of the General Data Protection Regulation (Regulation (EU) 2016/679 — "GDPR"), markoto is the **data controller** of personal data you provide directly (your account, your billing details). Where you use markoto inside a workspace owned by another party, that workspace's owner is the controller of any content you place inside their workspace, and markoto acts as a **processor** under a Data Processing Addendum (see `/legal/dpa`).

## 2. What data we process and why

We follow the principle of data minimisation: we collect the smallest amount of data needed for each purpose, and we tell you what each purpose is.

The full table of processing purposes — including lawful basis, data categories, retention period, and which sub-processors are involved — is rendered at the end of this page from our internal registry. Any change to this table is treated as a material change to this policy and bumps the policy version (see §13).

## 3. Lawful basis (GDPR Article 6)

Each processing activity rests on one of the following lawful bases:

- **Contract** (Article 6(1)(b)) — for everything required to deliver the service you signed up for: account creation, document storage, AI assistance, billing.
- **Legal obligation** (Article 6(1)(c)) — for retention obligations under tax law (billing records) and security audit logging.
- **Legitimate interest** (Article 6(1)(f)) — for fraud and abuse prevention, error monitoring, and security telemetry. You can object to processing on this basis (see §6).
- **Consent** (Article 6(1)(a)) — for product analytics and session replay. We never load these unless you've granted consent in the cookie banner. You can withdraw at any time.

## 4. Sub-processors and international transfers

We use a small list of sub-processors, all governed by GDPR Article 28 contracts. The current list is at `/legal/sub-processors`.

Where a sub-processor processes data outside the European Economic Area, we rely on:

- The **EU-US Data Privacy Framework** adequacy decision (10 July 2023) for US-based, DPF-certified recipients, AND
- **Standard Contractual Clauses** (2021/914) as a fallback in case the DPF adequacy decision is invalidated.

We notify workspace-owner customers at least 30 days in advance of any new sub-processor.

## 5. Storage location and retention

Application data and documents live in OVHcloud's managed PostgreSQL and Object Storage in the European Union (France). AI-related processing is performed by Google in the United States. Billing data is held by Stripe under EU/US dual hosting. Transactional emails (deletion confirmations, data-export-ready notifications, breach notifications) are dispatched via Resend; only the recipient address, subject line, and message body transit Resend's systems, and Resend retains those for 30 days for deliverability monitoring.

Retention follows the per-purpose schedule in §11. As a general rule:

- **Account data** persists until you request deletion.
- **Documents and content** persist until you delete them or your account.
- **AI prompt and tool-call records** are retained for 90 days for abuse-prevention review, then purged.
- **Audit logs** are retained for the period required by law (typically 12 months for security-related logs).
- **Billing records** are retained for the legal minimum imposed by EU and member-state tax law (typically 7–10 years).
- **Transactional email metadata** (recipient + send timestamp + delivery status) is retained by Resend for 30 days; we do not store email bodies after delivery.

## 5b. What happens when you delete your account

We want to be fully transparent about what deletion does. The button at `/settings/profile` schedules your account for permanent deletion **30 days from now**. During that grace period your account remains usable; you can cancel from any page that shows the deletion banner. After the 30 days elapse, the following runs automatically — there is no further confirmation, no further chance to recover anything.

### What gets permanently deleted

- **Your account row** — name, email, OAuth identifiers, preferences, locale, age confirmation, accepted-policy versions.
- **Every document you own** — including documents you've shared with collaborators in edit mode. Co-collaborators lose access to those documents at the same time. *If you want collaborators to keep a document, transfer it to them or duplicate it under their account before requesting deletion.*
- **Every saved theme** under your account.
- **Every workspace where you are the only member** — and every document and knowledge file inside those workspaces. *If you want to keep workspace content, either invite a co-member before deleting your account, or download the documents first using the data-export feature at `/settings/profile`.*
- **Your AI usage** — past prompts (we keep these privately for 90 days for abuse review), the per-billing-period interaction counter, any open AI sessions.
- **Your data export jobs** and any ZIP files we'd prepared for you.
- **Your Stripe customer record** — we instruct Stripe to delete it. Stripe retains the underlying invoice and payment records for the period required by tax law (typically 7 to 10 years) regardless of our request.

### What gets anonymised — kept on the platform with your name removed

- **Comments you authored on documents you don't own** — the body stays so the conversation is intelligible to other participants, but your name and your account link are replaced with `[deleted user]`.
- **Audit-log entries** — we keep our internal security log with your account id removed but the surrounding action retained. Lawful basis: legitimate interest in fraud prevention + legal obligation. Retention follows our standard audit log policy.
- **Activity-log entries** — your edits / restores / theme changes on documents you DON'T own remain in the doc's activity feed under "Anonymous". Edits on owned docs go away with the doc.
- **Consent log entries** — we anonymise the user link but keep the historical record so we can demonstrate that consent was given (a GDPR Article 7(1) requirement).

### What happens to workspaces where you're an admin alongside others

If you are an admin of a workspace that has at least one other member when your account is deleted, **we automatically promote one of the remaining members to admin** — the longest-tenured member, preferring an existing admin, then an existing editor, then a viewer. The workspace and its content are preserved for the remaining members. The new admin is notified after the promotion.

The workspace's "owner" provenance field is reassigned to the new admin so the FK constraints are clean. Authorisation has always been driven by the membership role, not the owner field, so this is purely bookkeeping.

### Workspaces you should clean up manually first

Because workspace cascade-delete removes content owned by other members of a workspace where you were the only person, we strongly recommend you do the following before requesting account deletion if you want to ensure other people's work is preserved:

- For any workspace where you are the only member but want to keep the content: invite at least one collaborator with admin role first, then they will inherit the workspace.
- For any document you want a collaborator to keep: either transfer ownership to them (move it out of your workspace into one they own, OR duplicate it under their account), or have them download a copy first.
- For knowledge-base files you'd like preserved: download them outside markoto, since these are deleted with the workspace.

### Your data export

Before requesting account deletion, you can use the **data export** feature at `/settings/profile` to receive a ZIP archive of everything we hold about you — documents in markdown, comments you authored, billing history, workspace memberships, AI usage logs, and consent decisions. This is a separate flow that produces a downloadable file you can keep regardless of what happens to your markoto account.

### How long the cascade actually takes

A background job runs the cascade once per hour. In the worst case your data is fully purged within about an hour after the 30-day grace ends. You will receive a confirmation email when the deletion has been executed (subject to having an email on file).

### Cancelling

Until the cascade runs, you can cancel the scheduled deletion by signing in and clicking "Cancel deletion" from any page (a banner appears at the top of the screen during the grace window). After the cascade runs, your account, sessions, and content are gone — there is no recovery path.

## 6. Your rights (GDPR Articles 15–22)

You have the right to:

- **Access** the personal data we hold about you (Article 15) — use the export tool at `/settings/profile`.
- **Rectify** inaccurate data (Article 16) — edit your profile, or write to us.
- **Erase** your data ("right to be forgotten", Article 17) — use the delete tool at `/settings/profile`. We hold for 30 days then permanently purge.
- **Restrict** processing (Article 18) — write to us.
- **Object** to processing based on legitimate interest (Article 21) — write to us.
- **Data portability** (Article 20) — the export tool returns your data in machine-readable JSON, NDJSON, and Markdown.
- **Withdraw consent** (Article 7(3)) where processing is consent-based — toggle the relevant purpose in the cookie banner (footer privacy badge).
- **Lodge a complaint** with a supervisory authority (Article 77) — see §10.

We respond to all requests within 30 days. We do not charge for these requests except in the case of manifestly unfounded or excessive requests.

## 7. Automated decision-making

markoto does not make decisions producing legal or similarly significant effects on you based solely on automated processing. The AI assistant offers suggestions you choose to accept or reject — final authorship is always yours. Stripe performs automated risk scoring on payment attempts; if an attempt is declined on this basis you can request human review by writing to us.

## 8. AI features and transparency

markoto includes an AI writing assistant and a knowledge-base retrieval system. AI requests are routed through our self-hosted LiteLLM proxy to EU-resident providers: Mistral AI (text generation, voice transcription via Voxtral), Jina AI (embeddings for the knowledge base, single-URL page content extraction), Staan (web search via a proprietary European search index, EU-only routing), and Black Forest Labs (image generation, EU-pinned region). Web-search queries no longer transit US search backends. We disclose this to you in the user interface — every AI-assisted message carries a visible "AI" badge, and any AI-generated content placed in a public document is footed with a transparency notice. None of these providers use API content to train their models on the tiers we use.

If you would prefer a workspace where AI features are disabled entirely, your workspace administrator can toggle this in workspace settings. Anonymous and standalone documents may still use AI features unless you opt out at the account level (forthcoming).

## 9. Cookies and similar technologies

We use essential storage (a session cookie, a language preference, and your consent decision itself) to keep you logged in and remember your preferences — this requires no consent under the ePrivacy Directive. We use product analytics and session replay only with your consent, which you can grant or withdraw at any time from the "Privacy choices" link in the footer of every page.

We do not use cross-site advertising trackers and we do not sell or share data with advertisers.

## 10. Children

markoto is not directed at children under the digital age of consent in your country (16 in most EU member states; lower in some). If you become aware that a child has created an account in violation of this, please report to **{{privacyContactEmail}}**.

## 11. Right to lodge a complaint

If you believe we have failed to honour your rights, you have the right to lodge a complaint with the supervisory authority of your habitual residence, place of work, or place of the alleged infringement. Our lead supervisory authority is the **Commission Nationale de l'Informatique et des Libertés (CNIL)** in France. A list of all EU/EEA supervisory authorities is published by the European Data Protection Board.

## 12. Security

We protect data using transport encryption (TLS), at-rest encryption at the OVHcloud platform layer, scrypt password hashing, IP truncation in audit logs, and a documented breach-response runbook with a 72-hour notification commitment under GDPR Article 33.

If we become aware of a personal data breach affecting you, we will notify the supervisory authority within 72 hours and notify you without undue delay if the breach poses a high risk to your rights.

## 13. Changes to this policy

This is **version {{currentVersion}}**, effective **{{effectiveDate}}**. Material changes (new processing purposes, new sub-processors, changed retention) trigger a version bump and an in-product re-acceptance prompt. Previous versions are available on request from **{{privacyContactEmail}}**.

### Change log

- **v2 (2026-05-05).** Added Resend, Inc. as a sub-processor for transactional email delivery (deletion confirmations, data-export-ready notifications). Email metadata is retained by Resend for 30 days; bodies are not archived. The `transactional_email` processing purpose now references Resend in the lawful-basis registry.
- **v1 (2026-05-04).** Initial publication.
