---
title: What happens when you hit the AI cap
description: Each plan ships a monthly AI budget — see how the cap surfaces in the UI and what your options are.
category: writing
order: 12
---

# What happens when you hit the AI cap

AI is metered per interaction (a prompt + the AI's full agentic loop
through tools and final reply). Free, Pro, Max, Ultra each ship a
different monthly budget. When you run out, the prompt bar tells you
plainly — no surprise downgrades to a worse model, no silent failure.

::flow{id="what-happens-when-you-hit-the-ai-cap" hide-title}
::

## What just happened

Every interaction is counted in `ai_usage_period`, anchored to your
billing cycle (Stripe period if you're paid; calendar month otherwise).
When `interactions_used >= cap`, the prompt-bar submit returns a
`BudgetExhausted` error and renders the plan-up call-to-action inline.

The counter increments atomically (`INSERT … ON CONFLICT DO UPDATE`)
so two concurrent prompts can't both squeeze under the cap.

## What's next

- [What you get on each plan](/docs/account/plans) — Free / Pro / Max / Ultra side-by-side.
- [Upgrade to Pro](/docs/account/upgrade) — Stripe Checkout, instant credit.
- [Sponsor AI for your team](/docs/workspaces/sponsor-ai) — bill AI usage to a workspace owner so members never hit a personal cap.
