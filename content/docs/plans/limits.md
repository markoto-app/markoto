---
title: Plans and limits
description: What the free tier includes on markoto.app and when self-hosted, and what Pro, Team and Business add. Self-hosted limits are set by the operator.
category: plans
order: 1
featured: true
updated: '2026-11-25'
---

# Plans and limits

The free tier includes anonymous and signed-in documents, every
theme, every markdown extension, collaboration, comments, history and
restore, PDF export, workspaces, import and the MCP server. AI works with
your own AI provider, and on markoto.app with a small monthly allowance.

The limits differ by where markoto runs. **On a self-hosted instance** every
feature is on and the operator sets any limits. **On markoto.app** the free
plan is narrower:

- up to 3 members per workspace
- 30 days of history and restore
- 3 saved themes
- imports up to 10 MB per file
- 20 web searches and page reads a day, and 100 MCP tool calls a day (read-only: no write access over MCP)
- 3 AI jobs a day, each up to 200 AI Points
- no custom CSS, AI image generation, voice input, stronger AI model, single sign-on, workspace audit log, guests, brand kit, share controls or custom domains

Pro (for one person) and Team and Business (for a workspace) lift these limits and turn those features on.

What you see depends on where markoto runs:

| Where | Plans |
|---|---|
| **markoto.app** | Everyone starts on Free. The [pricing page](/pricing) shows three cards: Free, Pro and Teams (switch the Teams card between Team and Business), with prices in euros or Swiss francs, monthly or annual, per seat for Team and Business. Pro is bought for yourself ([Upgrade](/docs/plans/upgrade)); Team and Business are bought for a workspace and billed per seat ([Team and Business](/docs/plans/team-plan)). Plans are sold through Link, a Stripe company. |
| **A self-hosted instance** | No plans, no pricing page tiers, no purchase. Everyone is on the free tier, and the operator decides the limits (workspaces, knowledge storage, AI Points). |

::flow{id="what-you-get-on-each-plan" hide-title}
::

## What limits a plan sets

- **Workspaces you can own.** Workspaces you are invited to never count.
- **Members per workspace**, **how far back history and restore reach**, **saved themes**, **import size** and the daily caps on web tools, MCP tool calls and AI jobs (on markoto.app: the numbers above; unlimited on a self-hosted instance unless the operator sets them).
- **Knowledge storage**: files and bytes per workspace and per person ([knowledge](/docs/ai/knowledge-rag)).
- **Image storage**: the total size of the images you upload or the AI generates for you, across all your documents (100 MB on the free plan).
- **AI Points**, the monthly allowance for AI that the operator pays for. Calls on your own AI provider are not limited by it ([AI Points](/docs/plans/ai-budget)).
- **Team and Business**: a workspace subscription billed per seat (at least 3), with AI budget and storage shared by its members. The AI budget and storage limits on the pricing page are per seat: a 5-seat Team workspace gets five times the per-seat amount, shared. See [Team and Business](/docs/plans/team-plan).

## What features a plan includes

On markoto.app some features depend on the plan (the free plan has none of them):
custom CSS in themes, how far back history and restore reach, MCP write
access, and the AI image generation, voice input and the stronger AI model
that markoto pays for. Features a plan doesn't include show as locked
controls with a short note. **Your own AI provider is never limited by the
plan**: image generation, voice and any model work with your own key on
every plan.

Inside a Team or Business workspace, its plan applies to you, whatever your
own plan is. Your profile lists the workspaces that cover you, and documents
in such a workspace show the plan next to their title. Moving a document
out of the workspace pauses the features the new place's plan doesn't
include; nothing is deleted.

## Extra AI Points

Buying extra AI Points on top of a plan's monthly allowance is not
available on markoto.app yet. When a month's AI Points run out early, the
AI works again with the next month's allowance, or right away with
[your own AI provider](/docs/ai/provider).

## Seeing your usage

To see how much of each limit you use, click the usage chip in the top bar
(the AI Points meter, or **Your own AI provider**). Under **Storage & limits**
it lists your images, knowledge files, knowledge storage and the workspaces
you own, each as used / limit. A bar turns orange at three quarters full and
red when you are close to the limit. Your profile page shows your image
storage too.

Under the cards on the pricing page, **Compare all details** opens a table with every limit for each plan. The current numbers always come from the instance you are on:
open its pricing page to see them.

## What's next

- [Upgrade to Pro](/docs/plans/upgrade): for yourself.
- [Team and Business for a workspace](/docs/plans/team-plan): billed per seat.
- [Connect your own AI provider](/docs/ai/provider): AI on any plan.
