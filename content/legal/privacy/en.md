---
slug: privacy
locale: en
version: 6
effectiveDate: 2026-10-26
translationStatus: authoritative
---

# Privacy Policy

> **In short:** markoto stores the documents you write, the comments you leave, and the minimum we need to run your account. The service is currently free; paid plans are not offered yet. AI features run on EU-resident providers (Mistral AI for text and voice, Jina AI for embeddings and single-page fetching, Staan for web search, Black Forest Labs for image generation) unless you connect your own AI provider, in which case your AI content goes to the provider you chose. We don't sell your data, we don't run ads, and we don't train AI on your content. You can export the data we hold about you and delete your account at any time from your settings.

---

## 1. Who we are

markoto is operated by **{{controllerName}}** ({{controllerAddress}}). For any privacy question, write to **{{privacyContactEmail}}**.

For the purposes of the General Data Protection Regulation (Regulation (EU) 2016/679 — "GDPR"), markoto is the **data controller** of personal data you provide directly (your account and, if you join it, the paid-plans waitlist). Where you use markoto inside a workspace owned by another party, that workspace's owner is the controller of any content you place inside their workspace, and markoto acts as a **processor** under a Data Processing Addendum (see `/legal/dpa`).

## 2. What data we process and why

We follow the principle of data minimisation: we collect the smallest amount of data needed for each purpose, and we tell you what each purpose is.

The full table of processing purposes — including lawful basis, data categories, retention period, and which sub-processors are involved — is set out in the register in §13 below, which is generated from our internal registry. Any change to this register is treated as a material change to this policy and bumps the policy version (see §14).

## 3. Lawful basis (GDPR Article 6)

Each processing activity rests on one of the following lawful bases:

- **Contract** (Article 6(1)(b)) — for everything required to deliver the service you signed up for: account creation, document storage, AI assistance, and — once paid plans are offered — billing.
- **Legal obligation** (Article 6(1)(c)) — for security audit logging and, once paid plans are offered, retention obligations under tax law (billing records).
- **Legitimate interest** (Article 6(1)(f)) — for fraud and abuse prevention, error monitoring, and security telemetry. You can object to processing on this basis (see §6).
- **Consent** (Article 6(1)(a)) — for product analytics and session replay (we never load these unless you've granted consent in the cookie banner), and for the paid-plans waitlist (only if you tick the consent box when you sign up and then confirm the email we send you). You can withdraw at any time.

## 4. Sub-processors and international transfers

We use a small list of sub-processors, all governed by GDPR Article 28 contracts. The current list is at `/legal/sub-processors`. That list shows only the providers this deployment actually uses: for example, Stripe (payment processing) appears only once paid plans are switched on, and an AI provider that **you** connect yourself (see §8) is not our sub-processor and is not listed.

Where a sub-processor processes data outside the European Economic Area, we rely on:

- The **EU-US Data Privacy Framework** adequacy decision (10 July 2023) for US-based, DPF-certified recipients, AND
- **Standard Contractual Clauses** (2021/914) as a fallback in case the DPF adequacy decision is invalidated.

We notify workspace-owner customers at least 30 days in advance of any new sub-processor.

## 5. Storage location and retention

Application data and documents live in OVHcloud's managed PostgreSQL and Object Storage in the European Union (France). AI-related processing is performed by EU-resident providers — Mistral AI (France), Jina AI (Germany), Staan (EU), and Black Forest Labs (EU-pinned region) — routed through our self-hosted LiteLLM proxy. While the service is free we do not process payment data; once paid plans are offered, billing data will be held by Stripe. Application-error telemetry is processed by Sentry in its EU (Frankfurt) region. Transactional emails (deletion confirmations, data-export-ready notifications, breach notifications) are dispatched via Resend; only the recipient address, subject line, and message body transit Resend's systems, and Resend retains those for 30 days for deliverability monitoring.

Retention follows the per-purpose schedule in the register in §13. As a general rule:

- **Account data** persists until you request deletion.
- **Documents and content** persist until you delete them or your account.
- **Anonymous documents** (created without signing in, and not part of a workspace) are deleted automatically after 180 days without activity on the hosted service. Self-hosted deployments may configure a different period or disable this clean-up. Documents owned by an account and workspace documents are not deleted automatically.
- **AI prompt and tool-call records** are retained for 90 days for abuse-prevention review, then purged.
- **Audit logs** are kept for as long as needed for security and legal purposes. When you delete your account, your account id is removed from them (see §5b).
- **Billing records** do not exist while the service is free. Once paid plans are offered, they will be retained for the legal minimum imposed by EU and member-state tax law (typically 7–10 years).
- **Transactional email metadata** (recipient + send timestamp + delivery status) is retained by Resend for 30 days; we do not store email bodies after delivery.
- **Paid-plans waitlist.** If you join the waitlist on the pricing page, we store your email address, the language you signed up in, which version of the consent text you agreed to, when you signed up and confirmed, and — if you were signed in — a link to your account. We do not store your IP address. We use this only to tell you when paid plans launch. Your entry counts only after you click the confirmation link we email you (double opt-in); unconfirmed entries are deleted after 7 days. Every email contains an unsubscribe link that deletes your entry immediately; otherwise we delete the list at the latest 3 months after sending the launch announcement. Deleting your account also deletes a linked entry, and your data export includes it. The confirmation email is sent via Resend; the list itself is stored in OVHcloud's managed PostgreSQL in the EU.

## 5b. What happens when you delete your account

We want to be fully transparent about what deletion does. The button at `/settings/profile` schedules your account for permanent deletion **30 days from now**. During that grace period your account remains usable; you can cancel from any page that shows the deletion banner. After the 30 days elapse, the following runs automatically — there is no further confirmation, no further chance to recover anything.

### What gets permanently deleted

- **Your account row** — name, email, OAuth identifiers, preferences, locale, age confirmation, accepted-policy versions.
- **Every document you own** — including documents you've shared with collaborators in edit mode. Co-collaborators lose access to those documents at the same time. *If you want collaborators to keep a document, transfer it to them or duplicate it under their account before requesting deletion.*
- **Every saved theme** under your account.
- **Every workspace where you are the only member** — and every document and knowledge file inside those workspaces. *If you want to keep workspace content, either invite a co-member before deleting your account, or download the documents first using the data-export feature at `/settings/profile`.*
- **Your AI usage** — past prompts (we keep these privately for 90 days for abuse review), any open AI sessions, and any bring-your-own-key AI provider settings with their encrypted API keys (see §8).
- **Your data export jobs** and any ZIP files we'd prepared for you.
- **Your Stripe customer record, if one exists** (only possible once paid plans are offered) — we instruct Stripe to delete it. Stripe retains the underlying invoice and payment records for the period required by tax law (typically 7 to 10 years) regardless of our request.

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

Before requesting account deletion, you can use the **data export** feature at `/settings/profile` to receive a ZIP archive of everything we hold about you — documents in markdown, comments you authored, workspace memberships, AI usage logs, your AI provider settings (provider URL, model and capability — never the API key), your waitlist entry if any, consent decisions and, once paid plans exist, billing history. This is a separate flow that produces a downloadable file you can keep regardless of what happens to your markoto account.

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
- **Lodge a complaint** with a supervisory authority (Article 77) — see §11.

We respond to all requests within 30 days. We do not charge for these requests except in the case of manifestly unfounded or excessive requests.

## 7. Automated decision-making

markoto does not make decisions producing legal or similarly significant effects on you based solely on automated processing. The AI assistant offers suggestions you choose to accept or reject — final authorship is always yours. Once paid plans are offered, Stripe will perform automated risk scoring on payment attempts; if an attempt is declined on this basis you will be able to request human review by writing to us.

## 8. AI features and transparency

markoto includes an AI writing assistant and a knowledge-base retrieval system. AI requests are routed through our self-hosted LiteLLM proxy to EU-resident providers: Mistral AI (text generation, voice transcription via Voxtral), Jina AI (embeddings for the knowledge base, single-URL page content extraction), Staan (web search via a proprietary European search index, EU-only routing), and Black Forest Labs (image generation, EU-pinned region). Web-search queries no longer transit US search backends. We disclose this to you in the user interface — every AI-assisted message carries a visible "AI" badge, and any AI-generated content placed in a public document is footed with a transparency notice. None of these providers use API content to train their models on the tiers we use.

### Your own AI provider (bring your own key)

You can connect your own AI provider account (an OpenAI-compatible service from the choices offered in the settings, for example Mistral AI or OpenAI; self-hosted deployments of markoto may allow others) under **Settings → AI provider**, separately for chat, image generation and voice transcription. When you do, the content needed for that feature — your prompt, the relevant document context, voice recordings, and the generated result — is sent through our LiteLLM proxy to **the provider you chose, under your own agreement with that provider**. markoto does not select that provider, and it is not one of our sub-processors; its terms and data-protection practices (including where it processes data and whether it trains on API content) are those of your contract with it. We store your provider settings (provider URL, model name, and your API key, encrypted at rest) until you remove them or delete your account; only the last four characters of the key are ever shown back to you, the key is never included in your data export (the export contains the provider URL, model and capability only), and we do not write it to our application logs. Prompt and tool-call records follow the 90-day retention above. Embeddings always use our own EU-resident provider listed above.

Web search and single-page fetching are provided by us and work the same whether or not you use your own AI provider: the search query the assistant formulates (up to 400 characters, which may be derived from your prompt or document) is sent to Staan, and the web address the assistant wants to read is sent to Jina AI (Jina Reader), in both cases directly from our application (not via the LiteLLM proxy) and through our own account with that provider, not yours. Staan and Jina AI are our sub-processors, listed above. The search results or extracted page text are then summarised by your chat provider (your own provider if you connected one, otherwise ours), so that text is passed to it. To limit cost and abuse, each signed-in user may make a limited number of web searches and page fetches per hour and per day (by default 30 per hour and 100 per day, shared between the editor and MCP clients). To enforce this we keep counters in Valkey keyed by your internal user ID, which hold timestamps only — no query, address or content — and expire automatically after their time window. These tools are available only if the operator has configured them.

Using the AI features requires signing in. They are optional: document content is sent to an AI provider only when you invoke the assistant or upload files to a workspace knowledge base (which are embedded by Jina AI).

## 9. Cookies and similar technologies

We use essential storage (a session cookie, a language preference, and your consent decision itself) to keep you logged in and remember your preferences — this requires no consent under the ePrivacy Directive. We use product analytics and session replay only with your consent, which you can grant or withdraw at any time from the "Privacy choices" link in the footer of every page.

We do not use cross-site advertising trackers and we do not sell or share data with advertisers.

## 10. Children

markoto is not directed at children under the digital age of consent in your country (16 in most EU member states; lower in some). If you become aware that a child has created an account in violation of this, please report to **{{privacyContactEmail}}**.

## 11. Right to lodge a complaint

If you believe we have failed to honour your rights, you have the right to lodge a complaint with a data protection supervisory authority.

- **In the EU/EEA:** you may complain to the supervisory authority of your country of habitual residence, your place of work, or the place of the alleged infringement. A list of EU/EEA supervisory authorities is published by the European Data Protection Board. Because we are established in Switzerland (outside the EU/EEA), we are not covered by the GDPR "one-stop-shop" mechanism, so there is no single lead authority — you may approach your local authority directly.
- **In Switzerland:** the competent authority is the Federal Data Protection and Information Commissioner (FDPIC).

We would also welcome the opportunity to resolve your concern directly first — please write to us at **{{privacyContactEmail}}**.

## 12. Security

We protect data using transport encryption (TLS), at-rest encryption at the OVHcloud platform layer, scrypt password hashing, and IP truncation in audit logs. In the event of a personal data breach, we commit to notifying the competent supervisory authority within 72 hours as required by GDPR Article 33.

If we become aware of a personal data breach affecting you, we will notify the supervisory authority within 72 hours and notify you without undue delay if the breach poses a high risk to your rights.

## 13. Register of processing purposes

The table below is generated from our internal registry of processing purposes and lists only what this deployment actually does (for example, billing is listed only once paid plans are switched on). The table is maintained in English.

{{processingPurposesTable}}

## 14. Changes to this policy

This is **version {{currentVersion}}**, effective **{{effectiveDate}}**. Material changes (new processing purposes, new sub-processors, changed retention) trigger a version bump and an in-product re-acceptance prompt. Previous versions are available on request from **{{privacyContactEmail}}**.

### Change log

- **v6 (2026-10-26), editorial alignment with the free-only service.** Stripe and billing are described as relevant only once paid plans are offered (the sub-processor list and the register omit Stripe while billing is off). The register of processing purposes is now actually shown in §13. Corrected statements about audit-log retention, anonymous-document clean-up (180 days of inactivity), the retired interaction counter and the (non-existent) account-level AI opt-out.
- **v6 (2026-10-26).** Added the `user_directed_ai_provider` processing purpose: you can bring your own AI provider (chat, image generation, voice transcription). Content for those features is then sent to the provider you choose under your agreement with it; we store your provider settings with the API key encrypted at rest until you remove them or delete your account. Web search and page fetching are provided by us for every user, including those with their own AI provider: search queries go to Staan and fetched web addresses to Jina AI, and per-user hourly and daily usage counters (timestamps only, no content) are kept in Valkey.
- **v5 (2026-10-26).** Added the `paid_plans_waitlist` processing purpose (consent, double opt-in): email address, locale, consent record and optional account link, kept until you unsubscribe or at the latest 3 months after the paid-plans launch announcement; unconfirmed sign-ups deleted after 7 days. Stored in OVHcloud (EU); confirmation emails via Resend.
- **v2 (2026-05-05).** Added Resend, Inc. as a sub-processor for transactional email delivery (deletion confirmations, data-export-ready notifications). Email metadata is retained by Resend for 30 days; bodies are not archived. The `transactional_email` processing purpose now references Resend in the lawful-basis registry.
- **v1 (2026-05-04).** Initial publication.
