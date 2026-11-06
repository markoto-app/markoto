---
title: Business plan template in Markdown
description: A business plan template in Markdown with executive summary, market, business model, roadmap, financials and risks. Write it with co-founders and export a PDF.
keywords:
  - business plan template markdown
  - markdown business plan
  - startup business plan template
  - business plan pdf template
updated: '2026-11-06'
navGroup: templates
navLabel: Business plan template
navOrder: 50
---

# Business plan template in Markdown

A business plan is read by people deciding whether to give you money, time or a loan. They look for the same things in the same order: what you sell, to whom, why now, how you make money, and what could go wrong. This template has a section for each, with a short brief under every heading.

Below is the start of a plan for a made-up company, in the **Corporate report** theme. The first page is the cover; scroll the preview for the text.

::try-it{theme="business-report" height="760"}
---
source: |
  # Lindenhof Bakery Co-op

  [[toc]]

  ## Executive summary

  Lindenhof is a cooperative bakery for the four villages around Lindenhof, which lost their last bakery in 2025. We will bake bread and pastries six days a week and deliver to two village shops and 300 subscribers. We need EUR 180,000: 60% from 400 member shares, 40% from a bank loan.

  ## The problem

  The nearest bakery is 14 km away. A survey of 520 households found that 61% would buy bread locally at least three times a week.

  ## Business model

  | Revenue stream | Year 1 | Year 2 | Year 3 |
  |---|--:|--:|--:|
  | Bread subscriptions | 96,000 | 118,000 | 131,000 |
  | Village shops | 54,000 | 61,000 | 66,000 |
  | Café on Saturdays | 18,000 | 24,000 | 27,000 |
  | **Total (EUR)** | **168,000** | **203,000** | **224,000** |

  ## Risks and mitigations

  > [!WARNING]
  > Energy is the largest cost after wages. A 30% rise in energy prices would cut the year 2 margin from 6% to 2%.

  - **Too few subscribers.** We start baking only when 250 households have signed up.
  - **Key-person risk.** Two bakers share every recipe and every shift plan.
---
::

::cta{title="Write your plan from this template." label="Use this template" template="business-plan" theme="business-report" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the business plan template and the Corporate report theme selected. It starts with the same headings and a short brief in each section.
::

## What's in it

- **Table of contents** with page numbers, generated from the headings.
- **Executive summary.** Two or three sentences: the business, who it is for, the problem it solves, and the value in one line.
- **The problem and our solution.** The pain point, quantified, and how you address it.
- **Market and competition.** Market size if it matters, and the three main competitors in a table.
- **Business model and go-to-market.** Pricing, channels, unit economics and the first three ways you will find customers.
- **Roadmap, team, financials.** Milestones at 6, 12 and 18 months, one line per person, a three-year projection.
- **Risks and mitigations.** The three to five biggest risks and what you will do about each.

The briefs are Markdown comments: visible in the editor and to the AI assistant, never on the page or in the PDF.

## Who it's for

Founders writing a plan for a bank, an investor, a grant or a co-op meeting, and teams writing an internal plan for a new product line. Co-founders can work in the same document at once, comment on each other's numbers and restore an earlier version when a draft goes the wrong way.

## Making it read well

- **Cover page.** The Corporate report theme starts with a cover: title, subtitle, date and authors. Fill them in under **Cover page** in the document theme.
- **Tables for numbers.** Right-align number columns with `--:` in the table's second line, as in the example.
- **Charts.** A Mermaid `xychart-beta` block draws a bar or line chart from numbers you type into the source.
- **Call out one risk.** An alert block (`> [!WARNING]`) stands out on the page without extra formatting.

markoto has no spreadsheet: type the financials as tables, or import an Excel file, which is converted to Markdown tables.

## Questions

::faq{json-ld}
---
items:
  - q: Can I download the business plan as a PDF?
    a: Yes. File › Export › PDF gives you the same pages as the preview, with the cover, the table of contents and page numbers.
  - q: Can I keep the plan private?
    a: Yes, with a free account. Documents you create while signed in are yours and only open for the people you share them with. Without an account a document is anonymous, and anyone with its link can edit it.
  - q: Can the AI help write the plan?
    a: With an account, the writing assistant can draft or tighten a section. It follows the brief under each heading.
  - q: Does markoto calculate the financials?
    a: No. Tables hold numbers but don't compute them. Work out the figures in a spreadsheet and paste or import the result.
---
::

::cta{title="Your plan, as a document people can read." label="Use this template" template="business-plan" theme="business-report"}
Free on markoto.app, no sign-up needed.
::
