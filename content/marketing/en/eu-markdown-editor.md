---
title: A Markdown editor hosted in the EU
description: markoto.app stores documents in France, uses EU-based AI providers and only essential cookies. Who runs it, which providers it uses, and how to self-host.
keywords:
  - gdpr markdown editor
  - eu hosted markdown editor
  - markdown editor europe
  - google docs alternative eu
  - gdpr compliant collaborative editor
updated: '2026-11-17'
navGroup: use-cases
navLabel: Hosted in the EU
navOrder: 60
---

# A Markdown editor hosted in the EU

markoto is a collaborative Markdown editor run by a Swiss company. On markoto.app, your documents, images and backups are stored in the EU (France), and the AI features use providers based in the EU. This page sets out where data goes and what we don't claim, so you can check it against your own requirements. The [privacy policy](/legal/privacy) is the binding text; where this page and the policy differ, the policy applies.

## Who runs it

markoto.app is operated by **LatentSpace Labs GmbH** in Zurich, Switzerland. The privacy policy is written for both the Swiss Federal Act on Data Protection (FADP) and the EU GDPR. Switzerland and the EU recognise each other as providing adequate data protection, so data can move between them without extra safeguards.

## Where your data is stored

- **Documents, comments, history and account data**: OVHcloud managed PostgreSQL in France.
- **Images and the daily database backups**: OVHcloud Object Storage in France. Backups are encrypted and kept for about 30 days.
- **Knowledge files** you upload to a workspace: converted to text on our own servers, then the original file is deleted. Only the text and its search index are kept.

## Who else receives data

These are the service providers (sub-processors) markoto.app uses today, read from the same list as the [sub-processor page](/legal/sub-processors):

::sub-processors
::

In short: storage and every AI provider sit in the EU. The providers based in the United States are used for narrow jobs:

- **Google and GitHub** only if you choose to sign in with them. markoto reads your name, verified email address and account ID, and nothing else from those accounts.
- **Resend** delivers the few emails markoto sends (for example invitations and account-deletion confirmations).
- **Sentry** receives error reports. They are stored in Sentry's EU region (Frankfurt); the US company may access them for support and operations.

These transfers rely on the EU-U.S. and Swiss-U.S. Data Privacy Framework, with standard contractual clauses as fallback, as the privacy policy describes.

## AI features

The writing assistant, voice input, web search, page fetching and image generation all go through markoto's own AI gateway to EU-based providers: Mistral AI (France; data centres in the EU and EFTA countries) for text and voice, Jina AI (Germany) for knowledge-base search and reading web pages, Staan (France) for web search and Black Forest Labs for images (EU-pinned region).

- **Nothing is sent to an AI provider unless you use an AI feature.** AI needs an account; anonymous visitors can't use it.
- **No training on your content.** markoto doesn't train models. Jina AI and Staan state that they don't train on request data; with Mistral AI and Black Forest Labs, markoto has opted out of training.
- **Your own provider is your choice.** If you connect your own AI provider under Settings › AI provider, your AI requests go to that provider under your own agreement with it. It is then not markoto's sub-processor, and where it processes data depends on the provider you pick.
- **Prompts and tool calls** are kept for 90 days for abuse review, then deleted.

::flow-strip{id="use-your-own-ai-provider" frames="06" caption="Settings › AI provider: the writing assistant connected to a provider you chose."}
::

## No tracking cookies

markoto.app uses only storage that is strictly needed to run the service: the sign-in session, your language, and a few keys for anonymous documents. Visits to the public pages, like this one, are counted with a statistics tool we run ourselves, without cookies and without storing anything on your device; documents are never counted. There is no session replay, no advertising and no cross-site tracking, so there is no cookie banner. The privacy policy lists every cookie and storage key and explains the statistics.

Documents are not indexed by search engines: every document page sends a `noindex` instruction. A link can still be passed on, so treat a shared link as public.

## For schools, teams and companies

- **Data processing agreement.** When you create a workspace, markoto acts as your processor for the content your team puts in it, under the [Data Processing Addendum](/legal/dpa). You accept it when you create your first workspace.
- **Export.** Every user can download a ZIP of everything markoto holds about them (documents as Markdown, comments, settings, logs) from their profile.
- **Deletion.** Deleting an account takes effect after a 30-day grace period you can cancel. Then documents, workspaces where you are the only member and AI records are deleted, and your comments on other people's documents are anonymised.
- **New sub-processors** are announced to workspace owners at least 30 days in advance.

::flow-strip{id="data-export" frames="06" caption="The data export on the profile page: the archive is ready to download."}
::

## What markoto does not claim

- **No certification.** There is no such thing as a "GDPR certificate" for a product, and markoto holds no security certification of its own (no ISO 27001, no SOC 2). The storage provider publishes its own certifications.
- **Not end-to-end encrypted.** markoto's servers can read your documents; they have to, to render pages, make PDFs and run the AI. Data is encrypted in transit and at rest. If the server must not be able to read your content, use an end-to-end encrypted tool instead.
- **Not a legal opinion.** Whether markoto meets your organisation's obligations is for you or your data protection officer to decide. The privacy policy, the DPA and the sub-processor list are there to make that check possible.

## Full control: run it yourself

If your data must not leave your own infrastructure, [self-host markoto](/self-hosted-markdown-editor). A self-hosted instance runs the same code as markoto.app with Docker Compose on your own server, with sign-in through your own identity provider (OpenID Connect) and AI only on providers you configure, including local models. The preview and PDF export load nothing from third parties, so an instance works on an isolated network. On your own instance, you are the operator and the controller; markoto.app's providers are not involved.

## Questions

::faq{json-ld}
---
items:
  - q: Where are my documents stored?
    a: On markoto.app, with OVHcloud in France, in a managed PostgreSQL database. Images and the encrypted daily backups are in OVHcloud Object Storage, also in France.
  - q: Is markoto GDPR compliant?
    a: markoto.app is run to meet the GDPR and the Swiss FADP, and the privacy policy explains how. There is no official GDPR certification for products, so markoto doesn't claim one. Check the privacy policy, the data processing addendum and the sub-processor list against your own requirements.
  - q: Do US companies get my documents?
    a: No. Documents are stored in the EU and the AI providers are in the EU. US-based providers handle sign-in with Google or GitHub (if you choose it), transactional email and error reports.
  - q: Does markoto use my documents to train AI?
    a: No. markoto doesn't train models, and it has opted out of training with the AI providers that offer one.
  - q: Is there a data processing agreement?
    a: Yes, for workspace owners. markoto acts as processor for the content in your workspace under its Data Processing Addendum, which you accept when you create a workspace.
  - q: Is markoto end-to-end encrypted?
    a: No. The server needs to read documents to render pages and PDFs. Data is encrypted in transit and at rest.
  - q: Can I host markoto myself?
    a: Yes. markoto is source-available and installs on your own Linux server with Docker Compose. Then no data goes to markoto.app at all.
---
::

::cta{title="Write in an editor hosted in the EU." secondary-label="Read the privacy policy" secondary-to="/legal/privacy"}
Free on markoto.app, no sign-up needed to start a document.
::
