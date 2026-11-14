---
title: Publish as a web page
description: Put a copy of a document at its own public address, keep it out of search engines or let them list it, and show it on your own domain.
category: sharing
order: 5
updated: '2026-11-11'
---

# Publish as a web page

Publishing puts a copy of a document at its own public address, like
`pages.markoto.app/p/harbourline-depot-guide-k3x9za`. Anyone with the address can
read it: no account, no editor, nothing to download. Published pages have
an address of their own, separate from the editor's. (A self-hosted
instance may show them on its own address instead, at `/p/…`.) The document itself
keeps its sharing exactly as it is: a private document stays private.

The owner and the workspace's admins find **Publish as a web page** in the
share dialog. Publishing is included in every plan.

::flow{id="publish-a-document-as-a-web-page" hide-title}
::

## What the page shows

The page shows the document as it was when you published it, in its
design: fonts, colours, headings, code, tables, diagrams, maths and images.
It's laid out as a web page that reads well on a phone, so it has no cover
page, page numbers, headers or footers.

Changes you make afterwards don't appear on the page until you choose
**Update page**. The address stays the same.

## Address

markoto suggests an address made from the title. Change it under
**Address**: lowercase letters, digits and hyphens. The old address stops
working at once.

## Search engines

New pages ask search engines not to list them, so only people you give the
address to find them. Turn on **Let search engines list it** to allow it.

## Unpublish

**Unpublish** takes the page down at once; its address shows "not found".
Deleting the document unpublishes its page too.

## Show it on your own domain

> **Availability.** On markoto.app your own domain is part of the **Pro**,
> **Team** and **Business** plans (coming soon). A self-hosted instance
> offers it once its operator has set it up.

You can show a published page at your own address, such as
`docs.example.com`:

1. Open **Domains** from your account menu and add the domain.
2. At your DNS provider, add the two records markoto shows:
   - a **TXT** record that proves the domain is yours, and
   - a **CNAME** record that points the domain to markoto. For a domain
     without a subdomain (`example.com`), which can't have a CNAME, use
     your provider's ALIAS record or CNAME flattening instead.
3. markoto checks the records every few minutes, or right away with
   **Check now**. Once they are right, the domain is **Live** and gets an
   HTTPS certificate automatically within a minute or two.
4. In the document's share dialog, choose the domain under **Show on your
   domain**.

The domain shows only that page. Keep the two records: markoto checks them
regularly, and if they stay wrong for three days the domain stops.

The certificate comes from Let's Encrypt. Like every public certificate it
is listed in public certificate logs, so the domain name itself becomes
public, but the page's content doesn't.

## What's next

- [Link expiry and view-only links](/docs/sharing/link-settings).
- [Protect a document with a password](/docs/sharing/password-protect).
