---
title: Client proposal template in Markdown with PDF
description: A client proposal template in Markdown with cover page, summary, approach in phases, timeline, pricing table, terms and a signature block, as a PDF.
keywords:
  - client proposal template
  - proposal template markdown
  - consulting proposal template
  - quote template pdf
  - offer template for clients
updated: '2026-11-19'
navGroup: templates
navLabel: Client proposal template
navOrder: 140
---

# Client proposal template in Markdown

A proposal has to answer a purchasing team's questions in a fixed order: who is it for, what is the problem, what will you do, when, for how much, on what terms. This template has a section for each, a cover page, a pricing table that looks like an invoice and a signature block to print or sign.

Below is the start of a proposal for a made-up client, in the **Proposal** theme.

::try-it{theme="proposal" height="760"}
---
source: |
  # Website relaunch for Harbourline

  | | |
  |---|---|
  | **Prepared for** | Harbourline AG, Mara Keller |
  | **Prepared by** | Northlight Studio, Sam Weber |
  | **Date** | 2026-11-19 |
  | **Valid until** | 2026-12-31 |

  # Summary

  Harbourline's website loses visitors on phones and takes a week to update. We propose to rebuild it in **10 weeks** for **CHF 38,400**, so your team can publish changes the same day.

  # Our approach

  ## Phase 1: Content and structure (weeks 1-3)

  - Inventory of every page and its traffic.
  - New site map, agreed with you.

  ## Phase 2: Build (weeks 4-10)

  - Templates, migration and launch.

  # Investment

  | Item | Days | Rate | Amount |
  |---|---:|---:|---:|
  | Content and structure | 12 | 1,200 | 14,400 |
  | Build | 20 | 1,200 | 24,000 |
  | **Total (CHF)** | | | **38,400** |

  # Acceptance

  By signing, both parties accept this proposal and its terms.

  | Harbourline AG | Northlight Studio |
  |---|---|
  | | |
  | Place, date | Place, date |
---
::

::page-shots{caption="The first page of the proposal template: the cover with title, client and your company."}
---
pages:
  - src: /template-thumbs/proposal.webp
    alt: Cover page of the client proposal template with a title, the client's name and the author's company.
---
::

::cta{title="Start your proposal from this template." label="Use this template" template="proposal" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the client proposal template selected: the text and the Proposal theme in one. Each section starts with a short brief.
::

## What's in it

- **Cover page and facts.** The title, "Prepared for ..." and your company on the cover, and a table with client, author, reference, date and validity.
- **Summary.** Half a page for the decision-maker: the problem, your proposal, the duration and the price.
- **Your situation and objectives.** The client's problems in their words, then three to five outcomes that can be checked at the end.
- **Approach, timeline and investment.** One section per phase with its deliverables, a table of dates, and a pricing table with right-aligned amounts, a subtotal and a ruled total. Optional items get their own table, so the main price stays comparable.
- **Terms and acceptance.** Numbered clauses, and a signature block with a line to sign for each side.

The briefs under the headings are Markdown comments: visible in the editor and to the AI assistant, never on the page or in the PDF.

## From template to a team's proposal

Write a proposal once, then reuse it. With an account you can duplicate a finished proposal as the start of the next. For a team that needs every proposal to look the same, a workspace can keep a proposal as a template that members copy, and can lock the workspace design; see [proposals for consultants and agencies](/proposal-software-for-consultants).

## What it doesn't do

markoto has no e-signature and no payment: the signature block is for printing or signing on a copy. Prices are typed into a table; it doesn't calculate totals. Check amounts before you send.

## Questions

::faq{json-ld}
---
items:
  - q: Does the pricing table calculate the total?
    a: No. Tables are plain Markdown, so you type the amounts and the total yourself. The theme formats them like an invoice, with a ruled total.
  - q: Can the client sign it in markoto?
    a: No. markoto has no e-signature. Export the PDF, sign it on paper or with a signing tool you already use.
  - q: Can I add my logo?
    a: Yes, with an account, because a logo is an upload. The cover and the header have a place for it.
  - q: Can I send the client a link instead of a PDF?
    a: Yes. Share the document as read-only, or publish it as a web page. A link can also be protected with a password, and where your plan includes link settings it can be given an expiry date.
---
::

::cta{title="A proposal that looks like your company wrote it." label="Use this template" template="proposal"}
Free on markoto.app, no sign-up needed.
::
