---
slug: privacy
locale: en
version: 14
effectiveDate: 2026-11-17
translationStatus: authoritative
---

# Privacy Policy

> **In short:** markoto stores the documents you write, the comments you leave, and the minimum we need to run your account. The service is free; paid plans are not offered yet. AI features run on EU-based providers (Mistral AI for text and voice, Jina AI for embeddings and single-page fetching, Staan for web search, Black Forest Labs for image generation) unless you connect your own AI provider, in which case your AI content goes to the provider you chose. We use only essential cookies. We count visits to our public pages with our own statistics tool, which stores nothing on your device, and when you come from one of our Google ads and then sign up, we tell Google Ads that the ad worked, without loading any Google script. We don't sell your data and we don't train AI on your content. You can export the data we hold about you and delete your account at any time from your settings.

**Contents**

[[toc]]

---

## 1. Who we are

markoto is operated by **{{controllerName}}** ({{controllerAddress}}). For any privacy question, write to **{{privacyContactEmail}}**.

This policy is written to meet both the **Swiss Federal Act on Data Protection** (revised FADP, in force since 1 September 2023) and, where it applies to us, the EU **General Data Protection Regulation** (Regulation (EU) 2016/679, "GDPR"). The GDPR applies to us because we offer markoto to people in the EU and EEA.

We are the **controller** of personal data you give us directly: your account, anonymous documents (documents created without an account) you create, abuse reports and, if you join it, the paid-plans waitlist. Where you use markoto inside a workspace owned by someone else, that workspace's owner is the controller of the content placed in their workspace, and we act as their **processor** under our Data Processing Addendum ([/legal/dpa](/legal/dpa)).

## 2. What data we process and why

We collect only what each purpose needs, and we tell you what each purpose is. The full list of purposes, with lawful basis, data categories, retention and recipients, is in the register in §13. Whenever that register changes, we publish a new version of this policy (see §14).

In brief, we process:

- **Account data:** name, email address, the identifier from your sign-in provider (GitHub or Google), language, age confirmation, and which versions of our policies you accepted.
- **Last active day:** the date of the last day you used markoto while signed in. We keep only this one date and replace it every day. We use it only to count active accounts; nobody looks it up for a single person.
- **Content:** documents, comments, images, knowledge-base files, themes and who edited what.
- **AI usage:** prompts, document context and AI results, when you use the AI features.
- **Technical data:** IP addresses (used in short-lived form for rate limiting and stored only shortened in logs), browser type, error reports.
- **Single sign-on through your organisation, if your workspace uses it:** when a Team or Business workspace connects its own identity provider, we receive from it the identifier it uses for you, your name and email address, and, if the workspace uses automatic provisioning (SCIM), whether your access is active. We keep the link to your account and the time of your last sign-in until the workspace removes you or its sign-in setup, or you delete your account. Your organisation decides who gets access; we act for it as described in our Data Processing Addendum.
- **Guests of a workspace:** if a workspace invites you as a guest, its admins and editors see your name and email address among its guests, and we record which of its documents were shared with you, with view or edit access, and by whom, until the share ends, you leave the workspace or you delete your account. Workspace admins also see, per person, how many documents, knowledge files and images each member and guest keeps in the workspace (not their content, and not when anyone works).
- **Published pages and custom domains:** when you publish a document as a web page, we store a copy of it as it was at that moment (text, design, images and fonts), its address and who published it, and anyone with the address can read it. It isn't listed in search engines unless you allow that. If you show a page on your own domain, we store the domain name, a verification code and when we last checked your domain's DNS records. To serve the domain over HTTPS we request a certificate for it from Let's Encrypt (Internet Security Research Group, United States); like every publicly trusted certificate, it is entered in public Certificate Transparency logs, so the domain name becomes publicly visible. A document's content never reaches Let's Encrypt.
- **Visitor statistics and ad measurement:** which public pages are visited, from which campaign, and which steps (such as signing up) follow, counted without cookies by a statistics tool we run ourselves; and, if you arrive from one of our Google ads and then sign up, the ad's click identifier. Details in §9b.
- **Billing data, only once paid plans are offered:** your plan, its period and currency, the Stripe customer and subscription identifiers, invoices, AI credit purchases and their use, and your acceptance of the Paid Plans Terms ([/legal/paid-terms](/legal/paid-terms)). For a Team or Business workspace we also keep the seat count and who the billing admin is. The workspace's admins see each member's AI spend in that workspace for the current month and can set a limit per member; they don't see prompts or AI results. Paid plans and AI credits are sold through **Link** (Sold through Link, LLC, a Stripe company), which is the seller and merchant of record: at checkout you give your payment details, billing address and, if you buy as a business, your VAT number to Link and Stripe directly. They process this data as **independent controllers** under their own privacy policies ([stripe.com/privacy](https://stripe.com/privacy), [link.com/privacy](https://link.com/privacy)), not on our behalf; this includes taking the payment, tax and invoicing, fraud checks, refunds and the order support Link offers. From Stripe we receive what we need to provide your plan: your email address and name, the plan or credit pack, amounts, currency and country, and the payment status. We also record when your plan started, changed, was cancelled or ended; when you delete your account, these records lose any link to you. Card details go to Stripe only; we never receive them.

## 2b. Anonymous documents, the bot check and abuse reports

**Anonymous documents.** You can create a document without an account. Before your browser creates its first one, you tick a box to accept our Terms and confirm that you are at least 16, and your browser solves a bot check. We store with the document the version of the Terms you accepted and the time, and a hash of a random creator key that your browser keeps in a cookie so that it alone can delete the document. Your browser also remembers your acceptance in a cookie, so you are not asked again until the Terms change (see §9). We do not ask for your name or email address. Anyone with the link can open and edit the document; do not put other people's personal data into it. Anonymous documents are marked as user content, with a link to report them. Anonymous documents are deleted automatically after **30 days** without being edited, together with the terms acceptance stored with them. Only edits count: opening or reading a document does not reset this period.

**Search engines.** Every document page, with or without an account, tells search engines not to index it (an `X-Robots-Tag: noindex` header and a matching meta tag). Our `robots.txt` deliberately does not block documents, because a search engine has to be able to fetch a page to see that instruction. A link to a document can still be passed on, so treat a shared link as public.

**Bot check.** The bot check is a proof-of-work puzzle (ALTCHA) that our own server issues and your browser solves. It involves no third party and sets no cookie. We check the solution and keep a fingerprint of the used puzzle for about 20 minutes so that it cannot be reused. To prevent mass creation, we count anonymous requests per IP address (for IPv6, per /64 network) in a short-lived store; these counters contain no content and expire within a day.

**Abuse reports.** Anyone can report content, also without an account (then protected by the same bot check).

- **What we store.** The address of the reported content, your explanation, the category, your name and email address (you may leave these out only when you report child sexual abuse material), the language you used, when you confirmed that your report is made in good faith, the time, a shortened IP address and a hash of your browser's user agent (against report flooding), and your account if you were signed in.
- **What we use it for.** To handle your report, to confirm receipt and tell you our decision by email, and, where the law requires it, to inform authorities.
- **What the owner receives.** If we remove or restrict a document, we send its owner a statement of reasons by email; it does not name you. For an anonymous document, we cannot reach its creator and record the statement as undeliverable.
- **How long we keep it.** We keep a copy of every notice we send, or could not deliver, with the report. We keep a report while it is open and delete it, with these notices, **1 year after the case is closed** (when we have acted on it or decided not to).
- **Your data export** includes the reports you filed while signed in with the notices sent to you, and the statements of reasons you received as a document owner.

## 3. Lawful basis

Under the GDPR, each processing activity rests on one of these lawful bases (Art. 6 GDPR). Under the FADP, we process personal data in line with its principles (Art. 6 FADP) and, where a justification is needed, rely on the same grounds (Art. 31 FADP).

- **Contract** (Art. 6(1)(b) GDPR): everything needed to provide the service you use: accounts, documents, collaboration, AI assistance and, once paid plans are offered, billing.
- **Legal obligation** (Art. 6(1)(c) GDPR): the security audit log, handling abuse reports and legal orders (EU Digital Services Act), and, once paid plans are offered, keeping billing records under tax law.
- **Legitimate interest** (Art. 6(1)(f) GDPR): keeping the service secure and free of abuse (rate limits, the bot check, terms acceptance for anonymous documents, error monitoring) and sending workspace invitations. You can object to processing on this basis (see §6).
- **Consent** (Art. 6(1)(a) GDPR): only for the paid-plans waitlist (you tick the box and confirm the email we send you). You can withdraw at any time with the unsubscribe link.

## 4. Recipients and international transfers

We use a small number of service providers ("sub-processors") under written data-processing agreements (Art. 28 GDPR, Art. 9 FADP). The current list is at [/legal/sub-processors](/legal/sub-processors). It shows only the providers this deployment actually uses: Stripe (payments) appears only once paid plans are switched on, and an AI provider that **you** connect yourself (see §8) is not our sub-processor and is not listed. Stripe keeps the subscription records we manage for you on our behalf; for the purchase itself, Stripe and Link (the seller of paid plans, see §2) act as independent controllers.

**Where your data goes.** We are based in Switzerland. Our database, file storage and backups are in the EU (France). Our AI providers process data in the EU; Mistral AI also uses data centres in EFTA countries. The Swiss Federal Council recognises the EU and EEA states as providing adequate data protection, and the European Commission recognises Switzerland as adequate. Every EFTA country is either an EEA state or Switzerland, so no further safeguards are needed for these transfers.

Some providers are based in the **United States**:

| Provider | What they receive | Safeguard |
| --- | --- | --- |
| Google LLC | Sign-in, only if you choose "Sign in with Google" | Data Privacy Framework, with standard contractual clauses as fallback |
| GitHub, Inc. | Sign-in, only if you choose "Sign in with GitHub" | Data Privacy Framework, with standard contractual clauses as fallback |
| Resend, Inc. | Recipient address and content of emails we send you | Data Privacy Framework, with standard contractual clauses as fallback |
| Functional Software, Inc. (Sentry) | Error reports: technical details, the page or request concerned, your internal user ID. Stored in Sentry's EU region (Frankfurt); the US company may have access for support and operations | Data Privacy Framework, with standard contractual clauses as fallback |
| Google Ireland Limited and Google LLC (Google Ads) | The click identifier of one of our ads you clicked and the time you then signed up, joined the waitlist or created your first document; nothing else (§9b). Only while we measure ad conversions | Data Privacy Framework, with standard contractual clauses as fallback |
| Stripe, Inc. and Sold through Link, LLC (Link) | Billing data, only once paid plans are offered (not currently in use): as our processor for your subscription records, and as seller and independent controller for the purchase (see §2) | Data Privacy Framework, with standard contractual clauses as fallback |

For these transfers we rely on the **EU-U.S. Data Privacy Framework** (European Commission adequacy decision of 10 July 2023) and the **Swiss-U.S. Data Privacy Framework** (recognised by the Swiss Federal Council with effect from 15 September 2024) for certified recipients, and otherwise on the European Commission's **standard contractual clauses** (2021/914), adapted for Swiss law as the FDPIC requires.

We notify workspace owners at least 30 days in advance of any new sub-processor.

## 5. Storage location and retention

Application data and documents are stored in OVHcloud's managed PostgreSQL and Object Storage in the EU (France). AI processing is done by EU-based providers: Mistral AI (France; data centres in the EU and EFTA), Jina AI (Germany), Staan (France) and Black Forest Labs (EU-pinned region), routed through our own AI gateway. While the service is free, we process no payment data. Error reports are processed by Sentry in its EU (Frankfurt) region. Transactional emails are sent through Resend.

Retention follows the register in §13. In general:

- **Account data** is kept until you delete your account.
- **Documents and content** are kept until you delete them or your account.
- **Anonymous documents** (created without an account and not part of a workspace) are deleted automatically after **30 days** without being edited. Documents owned by an account and workspace documents are not deleted automatically.
- **AI prompts and tool calls** (what you asked and what the AI did) are kept for 90 days for abuse review, then deleted.
- **AI cost records** (for each AI request we pay for: cost, model, time and your internal user ID; no content) are kept by our AI gateway for 90 days, and your monthly total until the allowance resets. We use them to enforce the per-account limit and the shared monthly pool. Requests to your own provider are recorded too, at zero cost, to apply rate limits.
- **Audit log.** Our security audit log records who changed access controls, deleted content or performed other security-relevant actions, with IP addresses shortened (IPv4 to /24, IPv6 to /48). Entries are deleted automatically after **2 years**. If you delete your account earlier, your account ID is removed from them straight away. In a workspace whose plan includes the audit log (Business), the workspace's admins can see and download the entries about that workspace, including your name and the shortened IP address for actions you took in it.
- **Backups.** We take an encrypted backup of the database once a day and keep the last 30, so each backup is kept for about **30 days**. Data you delete therefore remains in our backups for up to 30 days before it is overwritten. Our database provider OVHcloud also keeps its own automatic backups for a limited period. We use backups only to restore the service after a failure.
- **Billing records** do not exist while the service is free. Once paid plans are offered, they will be kept for the period required by tax law (in Switzerland 10 years). Link and Stripe keep their own records of the purchase as the seller, under their privacy policies.
- **Transactional email.** Resend keeps delivery records (recipient, time, status) for 30 days. We do not keep copies of the emails we send.
- **Paid-plans waitlist.** If you join the waitlist on the pricing page, we store your email address, the language you signed up in, which version of the consent text you agreed to, when you signed up and confirmed, and, if you were signed in, a link to your account. We do not store your IP address. We use this only to tell you when paid plans launch. Your entry counts only after you click the confirmation link we email you (double opt-in); unconfirmed entries are deleted after 7 days. Every email contains an unsubscribe link that deletes your entry immediately; otherwise we delete the list at the latest 3 months after sending the launch announcement. Deleting your account also deletes a linked entry, and your data export includes it.
- **Published pages** are kept until you unpublish them or delete the document; their copied images and fonts are deleted with them, at the latest an hour later. **Custom domains** are kept until you remove them or delete your account.
- **Visitor statistics** are deleted after **13 months**. **Ad click identifiers** of a sign-up are deleted **90 days** after the sign-up, and with your account if you delete it earlier.
- **Workspace invitations.** When a workspace admin invites someone by email, we keep the address they typed, the offered role and who invited on a pending invitation. Nobody becomes a member without accepting it. The invitation is deleted when it is accepted, declined or revoked, and at the latest after 14 days. If email is set up, one invitation email with a single-use link is sent via Resend. Deleting your account deletes invitations addressed to you, and your data export lists the open invitations you received and sent.

## 5b. What happens when you delete your account

The button at [/settings/profile](/settings/profile) schedules your account for permanent deletion **30 days from now**. During that grace period your account remains usable, and you can cancel from any page that shows the deletion banner. After the 30 days, the following runs automatically, with no further confirmation and no way to recover anything.

### What gets permanently deleted

- **Your account**: name, email, sign-in identifiers, preferences, language, age confirmation, accepted policy versions.
- **Every document you own**, including documents you shared with collaborators in edit mode. Collaborators lose access at the same time. *If you want collaborators to keep a document, transfer it to them or duplicate it under their account first.*
- **Every saved theme** under your account.
- **Every workspace where you are the only member**, with every document and knowledge file in it. *To keep workspace content, invite a co-member before deleting your account, or download the documents first using the data export at [/settings/profile](/settings/profile).*
- **Your AI usage**: your past prompts and tool calls, your AI sessions, and any bring-your-own-key AI provider settings with their encrypted API keys (see §8). They are deleted at once, not on the 90-day schedule. AI cost records, which hold no content, are removed on their normal 90-day schedule (see §5).
- **Your data export jobs** and any ZIP files prepared for you.
- **Your Stripe customer record, if one exists** (only possible once paid plans are offered). We instruct Stripe to delete it; Stripe keeps invoice and payment records for the period required by tax law. Link and Stripe, as the seller and independent controllers, handle their own records of your purchases; ask them directly to delete those ([link.com/privacy](https://link.com/privacy)).

Deleted data remains in our encrypted database backups until they are overwritten, for up to 30 days (see §5).

### What gets anonymised: kept with your name removed

- **Comments you wrote on documents you don't own.** The text stays so the conversation still makes sense to others, but your name and account link are replaced with `[deleted user]`.
- **Audit-log entries.** We keep the security log entry with your account ID removed, until it is deleted after 2 years (see §5).
- **Activity-log entries.** Your edits, restores and theme changes on documents you don't own stay in the document's activity feed as "Anonymous". Entries on your own documents are deleted with them.
- **Consent records.** We remove the link to your account but keep the record, so we can show that consent was given (Art. 7(1) GDPR).

### Workspaces where you are an admin alongside others

If you are an admin of a workspace with at least one other member, **we automatically promote one of the remaining members to admin**: the longest-standing member, preferring an existing admin, then an editor, then a viewer. The workspace and its content stay with the remaining members, and the new admin is notified. The workspace's "owner" field is reassigned to the new admin; access has always been controlled by membership roles, so this is bookkeeping only.

### Clean up first

Workspace deletion also removes content that other people put into a workspace where you are the only member. Before requesting deletion:

- For a workspace you want to keep: invite at least one collaborator as admin, so they inherit it.
- For a document a collaborator should keep: move it into a workspace they own, duplicate it under their account, or have them download a copy.
- For knowledge-base files you want to keep: download them, since they are deleted with the workspace.

### Your data export

Before deleting your account, you can use the **data export** at [/settings/profile](/settings/profile) to get a ZIP archive of everything we hold about you: documents in Markdown, your comments, workspace memberships, AI usage logs, your AI provider settings (URL, model and capability, never the API key), your waitlist entry, consent records and, once paid plans exist, billing history.

### How long it takes

A background job runs once per hour, so your data is purged within about an hour after the grace period ends. You receive a confirmation email when the deletion has run (if we have an email address for you).

### Cancelling

Until the deletion runs, you can cancel it by signing in and clicking "Cancel deletion" in the banner at the top of the screen. After it runs, your account, sessions and content are gone.

## 6. Your rights

Under the GDPR (Art. 15–22) and the FADP (Art. 25–28 and 32), you have the right to:

- **Access** the personal data we hold about you: use the export at [/settings/profile](/settings/profile), or write to us.
- **Rectification** of inaccurate data: edit your profile, or write to us.
- **Erasure**: use the delete tool at [/settings/profile](/settings/profile). We wait 30 days, then delete permanently.
- **Restriction** of processing: write to us.
- **Object** to processing based on legitimate interest: write to us.
- **Data portability**: the export returns your data in machine-readable JSON, NDJSON and Markdown.
- **Withdraw consent** where processing is based on consent (currently only the waitlist): use the unsubscribe link.
- **Complain** to a supervisory authority (see §11).

We respond within 30 days. Requests are free unless they are manifestly unfounded or excessive.

## 7. Automated decision-making

We do not make decisions with legal or similarly significant effects on you based solely on automated processing. The AI assistant only makes suggestions that you accept or reject. Moderation decisions are always taken by a person (see the Terms, §8). Once paid plans are offered, Stripe and Link, as the seller, will score payment attempts for fraud risk automatically; if a payment is declined on that basis, you can ask them for a human review.

## 8. AI features and transparency

markoto includes an AI writing assistant and a knowledge-base search. AI requests go through our own AI gateway to these EU-based providers: Mistral AI (text generation, voice transcription; every request goes to its EU endpoint, data centres in the EU and in EFTA countries), Jina AI (embeddings for the knowledge base, extracting the content of a single web page), Staan (web search via a European search index) and Black Forest Labs (image generation, EU-pinned region).

**AI transparency.** When the AI works in a document, it appears as a separate collaborator, its answers are labelled as coming from markoto's AI, and its edits are recorded in the document's activity log as made by the AI.

**Training.** We do not use your content to train AI models. Our providers' terms differ:

- **Jina AI** states in its terms that it does not use customer request data, inputs or uploaded content to train its models.
- **Staan** states that search data is not used to train language models.
- **Mistral AI** and **Black Forest Labs** may, under their standard terms, use API content to improve their models unless the customer opts out. We have opted out of this with both providers.

### Free AI allowance

If you are signed in and have not connected your own provider for the writing assistant, the assistant runs on our **free AI allowance**:

- **Model and provider.** The allowance uses the model **GLM-5.3 Flash**, developed by Z.ai. It is served and processed by **Mistral AI SAS** on Mistral's own infrastructure through its **EU endpoint** (data centres in the EU and in EFTA countries). Z.ai receives no data. Mistral AI processes the requests as our sub-processor under our agreement with it, including the training opt-out described above.
- **What is sent.** Your prompt, the parts of the document the assistant reads, the results of the tools it uses (for example the text of a fetched page or search results to be summarised) and, if you ask about an image, the image. The answer comes back the same way.
- **Who can use it.** Only signed-in users. Anonymous visitors cannot use the AI.
- **Limits.** Each account has a monthly limit (currently 500 AI Points, about USD 0.50 of model usage). In addition, all free accounts together share a monthly pool. The allowance is available only while this month's pool lasts; when it is used up, the assistant tells you so until the next month starts. To enforce these limits, our AI gateway records the cost, the model used and the time of each request, linked to your internal user ID (retention: see §5).
- **No guarantee.** The allowance is a free extra. We may change the model, the limits or the pool, or end the allowance, and we do not guarantee that it is available at any given time.
- **Your own key replaces it.** As soon as you connect your own provider for the writing assistant (see below), your requests go to that provider instead and the allowance no longer applies to them.

### Your own AI provider (bring your own key)

You can connect your own AI provider account (an OpenAI-compatible service from the choices in the settings, for example Mistral AI or OpenAI) under **Settings → AI provider**, separately for chat, image generation and voice transcription. When you do, the content needed for that feature (your prompt, the relevant document context, voice recordings and the generated result) is sent through our AI gateway to **the provider you chose, under your own agreement with it**. We do not choose that provider and it is not our sub-processor; its terms and data-protection practices, including where it processes data and whether it trains on your content, are those of your contract with it. We store your provider settings (provider URL, model name and your API key, encrypted at rest) until you remove them or delete your account. Only the last four characters of the key are ever shown back to you, the key is never included in your data export, and we do not write it to our logs. Prompt and tool-call records follow the 90-day retention above. Embeddings always use our own provider listed above.

Web search and single-page fetching are provided by us, whether or not you use your own AI provider: the search query the assistant formulates (up to 400 characters, possibly derived from your prompt or document) is sent to Staan, and the web address the assistant wants to read is sent to Jina AI, directly from our application and through our account with those providers. The results are then summarised by your chat provider (your own if you connected one, otherwise ours). To limit cost and abuse, each user may make a limited number of web searches and page fetches (by default 30 per hour and 100 per day). We count them in a short-lived store under your internal user ID; the counters hold only timestamps and expire automatically.

The AI features require an account and are optional: document content is sent to an AI provider only when you use the assistant or upload files to a workspace knowledge base (which are embedded by Jina AI).

## 9. Cookies and similar technologies

markoto uses **only storage that is strictly necessary** to provide the service you ask for:

| Name | Purpose | Duration |
| --- | --- | --- |
| `nuxt-session` | Keeps you signed in (encrypted session cookie). Set only when you sign in. | 7 days |
| `ypad_locale` | Remembers your language. | 1 year |
| `markoto-anon-creator` | Random creator key that lets the browser which created an anonymous document delete it. Not linked to you; we store only a hash of it with the document. | 1 year |
| `markoto-anon-terms` | Remembers that you accepted the Terms before creating a document without an account: the Terms version and the time, signed by us, with no identifier. Set only when you accept. | 1 year, or until the Terms change |
| `nuxt-color-mode` (local storage) | Remembers light or dark mode, if you choose one. | Until you clear it |
| `markoto:preview-zoom` (local storage) | Remembers the zoom level of the document preview. | Until you clear it |
| `markoto-pending-invite` (session storage) | Keeps a workspace invitation link while you sign in to accept it. | Until you close the tab |
| `markoto-anon-avatar` (session storage) | A random token that picks the face your collaborators see while you work on a document without an account. It is also saved with the edits and comments you make without an account, so the activity log shows the same face. Not linked to you or your browser beyond that. | In the browser: until you close the tab. With your edits and comments: as long as the document (§5) |
| Service worker cache | Lets markoto load faster and work offline. | Until you clear it |

We use **no cookies or other browser storage for statistics or advertising, no session replay and no cross-site tracking**; our visitor statistics (§9b) work without them. Because all of this storage is strictly necessary for a service you explicitly request, it needs no consent under Art. 5(3) of the EU ePrivacy Directive and the national laws implementing it. Under Swiss law (Art. 45c of the Telecommunications Act), this section informs you about it, and you can block or delete cookies in your browser at any time; markoto may then not keep you signed in or let you delete anonymous documents. For this reason there is no cookie banner. If we ever want to use non-essential storage, we will ask for your consent first.

Our earlier cookie banner set a `markoto-anon` cookie to remember your choice. We no longer set it; it expires on its own, and you can delete it. Records of decisions made with that banner are kept as described in §5b.

## 9b. Visitor statistics and ad measurement

**Visitor statistics.** To learn which of our public pages are useful and which campaigns bring visitors, we count visits with Umami, an open-source statistics tool that we run on our own servers next to markoto; no third party receives the data. We count page views of the public pages (home page, pricing, documentation, legal and information pages), never your documents or published pages, and a few steps such as "clicked Start writing", "signed up" or "created a document", without their content. For each visit Umami records the page address without its query (except the campaign parameters `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content`), the website you came from (its domain only), your language and screen size, and the country, region and city, browser, operating system and device type derived from your request. To tell visits apart, it forms a one-way code from your IP address and browser identification together with a secret that changes every day, so the same visitor cannot be recognised on the next day. Your IP address itself is not stored, and nothing is stored on or read from your device for this. The data is deleted after 13 months. The lawful basis is our legitimate interest in understanding and improving our website (Art. 6(1)(f) GDPR).

**Ad measurement.** We advertise markoto on Google. When you click one of our Google ads, Google adds a click identifier (`gclid`, `gbraid` or `wbraid`) to the address of our page. We do not load any Google script or Google cookie. If you then sign up, join the paid-plans waitlist (and confirm it) or create your first document in the same visit, your browser sends that identifier along with that request, and we keep it with the kind and time of that step. We then tell Google Ads which of its ad clicks led to such a step (the click identifier and the time, no name, email address or IP address), so we can see which ads work. If you sign up through GitHub or Google, the identifier waits on our server for at most 15 minutes for you to come back. If you don't complete one of these steps, we keep nothing. The identifiers are deleted 90 days after the step, and with your account. The lawful basis is our legitimate interest in measuring whether our advertising works (Art. 6(1)(f) GDPR). Google Ads receives the data as described in §4.

**Opting out.** If your browser sends a Global Privacy Control or Do Not Track signal, we count nothing and keep no ad click identifier. You can also object at any time by writing to **{{privacyContactEmail}}** (Art. 21 GDPR).

## 10. Age requirement

You must be at least **16 years old** to use markoto, both with an account and for anonymous documents, whatever the age set by the law of your country. If you believe that someone under 16 is using markoto, please tell us at **{{privacyContactEmail}}** and we will delete the account or document.

## 11. Right to lodge a complaint

If you believe we have not respected your rights, you can complain to a data protection authority.

- **In Switzerland:** the Federal Data Protection and Information Commissioner (FDPIC), www.edoeb.admin.ch.
- **In the EU/EEA:** the supervisory authority of the country where you live or work, or where the alleged infringement took place. The European Data Protection Board publishes a list. As we are established in Switzerland, there is no single lead authority for us under the GDPR's one-stop-shop, so you can contact your local authority directly.

We would welcome the chance to resolve your concern first: write to **{{privacyContactEmail}}**.

## 12. Security

We protect data with encryption in transit (TLS), encryption at rest provided by our storage provider, encrypted database backups, encryption of stored secrets such as AI provider keys, strict separation of our internal services, least-privilege access, shortened IP addresses in logs, and regular security updates. markoto accounts have no passwords of their own: you sign in through GitHub or Google. If you protect a document with a password, we store only a scrypt hash of it. The measures are described in more detail in Annex I of our Data Processing Addendum ([/legal/dpa](/legal/dpa)).

If a personal data breach is likely to result in a risk to you, we notify the competent supervisory authority within 72 hours where the GDPR requires it (Art. 33 GDPR), and the FDPIC as soon as possible where the FADP requires it (Art. 24 FADP). If the breach is likely to result in a high risk to you, we also tell you without undue delay.

## 13. Register of processing purposes

The table below is generated from our internal registry of processing purposes and lists only what this deployment actually does (for example, billing is listed only once paid plans are switched on). The table is maintained in English.

{{processingPurposesTable}}

## 14. Changes to this policy

This is **version {{currentVersion}}**, effective **{{effectiveDate}}**. Material changes (new processing purposes, new sub-processors, changed retention) change the version and lead to an in-product prompt to accept the new version. Previous versions are available on request from **{{privacyContactEmail}}**.

### Change log

- **v14 (2026-11-17).** Added visitor statistics of our public pages with Umami, which we run ourselves, without cookies or other storage on your device, deleted after 13 months; and ad measurement for our Google ads without any Google script: if you come from one of our ads and sign up, join the waitlist or create your first document, we keep the ad's click identifier for 90 days and report it with the time of that step to Google Ads, which is a new recipient (§2, §4, §5, §9, §9b). Global Privacy Control and Do Not Track switch both off. Added to your data export (`ad_conversions.ndjson`). Added the last active day (§2): one date, replaced every day, used only to count active accounts. Added to your data export (`profile.json`, `lastActiveOn`). Once paid plans are offered we also record when a plan started, changed, was cancelled or ended (§2); your data export lists yours (`billing/subscription_history.json`), and after you delete your account these records stay without any link to you. Paid plans and AI credits, once offered, are sold through Link (Sold through Link, LLC, a Stripe company) as seller and merchant of record (§2, §4, §5, §5b, §7): the payment details, billing address and VAT number you enter at checkout go to Link and Stripe, which process them as independent controllers under their own privacy policies; we receive the order data needed to provide your plan.
- **v13 (2026-11-10).** Described publishing a document as a web page and showing it on your own domain (§2, §5): the published copy and its address, the domain name, its verification and DNS checks, and the HTTPS certificate requested from Let's Encrypt, which makes the domain name public in Certificate Transparency logs. Added to your data export (`published_pages.json`, `custom_domains.json`).
- **v12 (2026-11-09).** Described workspace guests (§2): who sees a guest's name and email address, the record of which documents were shared with them, and the per-person usage view for workspace admins. Added to your data export (`document_shares.json`).
- **v11 (2026-11-09).** Workspace admins of a plan with the audit log can see and download that workspace's audit entries, including the name and shortened IP address of the person who acted (§5).
- **v10 (2026-11-09).** Described single sign-on through a workspace's own identity provider (OpenID Connect or SAML) and automatic provisioning (SCIM) (§2): the identifier, name and email address the provider sends, the link to your account, your last sign-in and whether your access is active. Added to your data export (`sso_identities.json`).
- **v9 (2026-11-09).** Described the billing data we process once paid plans are offered (§2): plans, Team and Business workspaces with their seats and billing admin, AI credits, and the acceptance of the new Paid Plans Terms. Workspace admins of a Team or Business workspace see each member's monthly AI spend in that workspace (not prompts or results) and can set a per-member limit.
- **v8 (2026-11-03).** Removed the "product analytics" and "session replay" purposes and the cookie banner: neither was ever in use, and markoto uses only strictly necessary storage (§9 lists it). Added the Swiss FADP alongside the GDPR, and the countries data is transferred to (§4). Described anonymous documents (terms acceptance, bot check, deletion 30 days after the last edit; previously 180 days), noindex on documents and abuse reports without an account, with receipt, decision and statement-of-reasons notices (§2b). Stated backup retention (about 30 days), audit-log retention (2 years) and abuse-report retention (1 year after the case is closed). Corrected the statement on password hashing, the age rule (16 everywhere), the AI labelling description and the statements on AI training per provider. Added the free AI allowance for signed-in users (GLM-5.3 Flash by Z.ai, served and processed by Mistral AI on its EU endpoint; Z.ai receives no data), its monthly per-account limit and shared monthly pool, and the retention of AI cost records, which are kept for 90 days also after an account is deleted (§5, §5b, §8). All requests to Mistral AI, including voice transcription and live dictation, go to its EU endpoint (§8). Profile pictures from GitHub, Google or your organisation's sign-in are no longer stored or shown: avatars are drawn in your browser from your account number, and visitors without an account get a random one (`markoto-anon-avatar`, §9).
- **v7 (2026-10-27).** Added the `workspace_invitations` processing purpose (legitimate interest): when a workspace admin invites someone by email, we keep that email address, the offered role and who invited on a pending invitation until the person accepts or declines it, an admin revokes it, or it expires after 14 days. Nobody joins a workspace without accepting. If email is set up, one invitation email per invite is sent via Resend (at most three per address per day). Stored in OVHcloud (EU).
- **v6 (2026-10-26), editorial alignment with the free-only service.** Stripe and billing are described as relevant only once paid plans are offered (the sub-processor list and the register omit Stripe while billing is off). The register of processing purposes is now actually shown in §13. Corrected statements about audit-log retention, anonymous-document clean-up (180 days of inactivity), the retired interaction counter and the (non-existent) account-level AI opt-out.
- **v6 (2026-10-26).** Added the `user_directed_ai_provider` processing purpose: you can bring your own AI provider (chat, image generation, voice transcription). Content for those features is then sent to the provider you choose under your agreement with it; we store your provider settings with the API key encrypted at rest until you remove them or delete your account. Web search and page fetching are provided by us for every user, including those with their own AI provider: search queries go to Staan and fetched web addresses to Jina AI, and per-user hourly and daily usage counters (timestamps only, no content) are kept in Valkey.
- **v5 (2026-10-26).** Added the `paid_plans_waitlist` processing purpose (consent, double opt-in): email address, locale, consent record and optional account link, kept until you unsubscribe or at the latest 3 months after the paid-plans launch announcement; unconfirmed sign-ups deleted after 7 days. Stored in OVHcloud (EU); confirmation emails via Resend.
- **v2 (2026-05-05).** Added Resend, Inc. as a sub-processor for transactional email delivery (deletion confirmations, data-export-ready notifications). Email metadata is retained by Resend for 30 days; bodies are not archived. The `transactional_email` processing purpose now references Resend in the lawful-basis registry.
- **v1 (2026-05-04).** Initial publication.
