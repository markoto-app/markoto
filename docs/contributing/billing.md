# Billing, plans and AI budgets

The same code runs a self-hosted instance (billing off), the free-only hosted service (billing off, paid plans shown as coming soon) and a paid service (billing on). This page explains how plans, limits, AI budgets and Stripe fit together. Agent rules: `server/utils/AGENTS.md` → Billing.

## Billing mode

`NUXT_BILLING_ENABLED` (default off) is read through the typed env (`shared/config/billingMode.ts`), which tests stub with `vi.stubEnv`. Server helpers are in `server/utils/billing/billingMode.ts`:

- `assertBillingEnabled()`: 404 `billing/disabled` at the top of checkout, portal, seats, top-up and the Stripe webhook.
- `effectivePlan(plan, validUntil)`: `free` whenever billing is off, and for a lapsed paid plan.
- `limitRecovery()`, `limitUpgradeHint()`, `budgetExhausted*()`: limit messages that point at an upgrade only when one can be bought.

With billing off, Stripe environment variables are not required at boot (the billing rule in `shared/env/rules/billing.ts`), the billing jobs do not start, and account deletion and data export skip their Stripe steps. `NUXT_PLANS_COMING_SOON=true` opens the paid-plans waitlist (`server/utils/privacy/waitlist.ts`).

## Plans and entitlements

Plans are `free` and `pro` (personal, `users.plan`) and `team` and `business` (per workspace, `workspace_subscriptions`). Limits and feature switches per plan live in `shared/config/tiers.ts`; `server/utils/billing/tierConfig.ts#getTiers()` applies `TIER_<PLAN>_<FIELD>` and `TIER_<PLAN>_FEATURE_<NAME>` overrides. The committed free tier is the self-hosted tier: every feature on, no extra limit. The hosted service narrows it through `infra/render-env.sh`.

`server/utils/billing/entitlements.ts` decides whose plan applies:

- `resolveDocPlan` / `resolveDocPlanFor`: document features: the workspace's plan, else the owner's; anonymous documents are `free`.
- `resolveWorkspacePlan`: the better of the workspace subscription (with billing on) and the workspace creator's personal plan.
- `resolveUserPlan`: personal limits.

Refusals use `assertPlanFeature`, `assertPlanLimit`, `planLimitError` and `assertWithinHistory`: 409 `plan/feature-unavailable` or `plan/limit-reached` with `messageKey` and `limitRecovery()`. Features that can also be written through Y.js (custom CSS, the brand lock) are enforced again at render time, because Y.js writes bypass the API.

## AI budgets

The LiteLLM proxy enforces every platform-paid AI budget; the app keeps no usage counter.

- **Personal key** (`server/utils/litellm/userKeys.ts`): each user gets a LiteLLM virtual key on first AI use (`ensureUserKey`), stored as `users.litellm_key_id` plus the AES-256-GCM-encrypted token. `max_budget` comes from the plan (`userKeyBudgetUsd`) and resets every 30 days (`budget_duration: '30d'`). With `LITELLM_TEST_STUB=1` key creation returns a stub.
- **Free pool**: with `NUXT_FREE_TIER_TOTAL_BUDGET_USD` set, every free key is also a member of the LiteLLM team `markoto-free-tier`, whose budget caps all free users together (`server/utils/litellm/freeTierTeam.ts`). When the pool is spent the API answers 402 `ai/free-allowance-exhausted`.
- **Workspace pool** (Team / Business, billing on): one LiteLLM team `markoto-ws-<workspaceId>` per workspace with budget = seats × per-seat budget, and one key per member inside it with an optional member limit (`server/utils/litellm/workspaceTeams.ts`). A guest never gets a member key.
- `resolveBillingContext(userId, workspaceId)` (`server/utils/billing/billing.ts`) picks the key for a request: the member key inside an entitled workspace, else the personal key. Callers make the request through `useLitellmForUser(virtualKey)` (`server/utils/ai/litellmClient.ts`) and recognise budget errors with `isBudgetExceededError`, `isWorkspaceTeamBudgetError` and `isFreeAllowanceExhaustedError`.
- `litellm-key-reconcile` (at boot and every 6 h, `server/utils/litellm/keyReconcile.ts`) brings every key and team in line with the current plans.

Bring-your-own-key requests go through LiteLLM too, but on a zero-cost deployment, so they never draw on these budgets.

## Stripe

`server/utils/billing/stripeClient.ts` pins the API version to `STRIPE_API_VERSION` (`shared/contracts/stripe.ts`). Prices are found by lookup key `<prefix>_<plan>_<month|year>_<eur|chf>` (prefix `NUXT_STRIPE_LOOKUP_KEY_PREFIX`), or set explicitly with `NUXT_STRIPE_PRICE_IDS` (`server/utils/billing/stripePrices.ts`). An unknown price is logged and skipped.

A Stripe customer belongs to one subject: a user (personal Pro, `users.stripe_customer_id`) or a workspace (its own customer, `workspace_subscriptions.stripe_customer_id`). Checkout routes on `client_reference_id`: a user id, or `workspace:<id>`.

### Webhook

`POST /api/webhooks/stripe` verifies the signature and calls `dispatchStripeEvent` (`server/utils/billing/stripeWebhook.ts`), which runs in one transaction:

1. **Deduplicate**: insert `event.id` into `processed_webhook_events` with `ON CONFLICT DO NOTHING`; an existing row means a redelivery, answered 200 without re-applying anything.
2. **Stash out-of-order events**: Stripe does not order deliveries. A `customer.subscription.*` or `invoice.*` event for a customer no subject owns yet is stored in `pending_stripe_events`.
3. **Dispatch** to the handler for the event type through the table in `server/utils/billing/stripeEvents/eventHandlers.ts`. The table is the list of handled types (`HANDLED_STRIPE_EVENT_TYPES` is derived from it): an event type without an entry is acknowledged unhandled. One module per event family under `stripeEvents/`: `checkoutCompleted.ts`, `creditTopups.ts` (top-up checkouts, delayed payments, refunds), `subscriptionEvents.ts` (created / updated / deleted), `invoiceEvents.ts` (paid / failed); `billingSubjects.ts` resolves a customer to its user or workspace, `stripeObjects.ts` reads the version-dependent fields. Their writes go through `server/repos/userBilling.ts`, `server/repos/workspaceSubscriptions.ts` and `server/repos/stripeWebhookEvents.ts`.
4. **Drain**: after `checkout.session.completed`, stashed events for that customer are replayed in arrival order.

Only the subscription a row tracks is applied: a late event about an older or cancelled subscription cannot bring a plan back. Version-dependent fields are read through `subscriptionPeriod`, `invoiceSubscriptionId` and `invoiceServicePeriod` (`stripeEvents/stripeObjects.ts`), because the pinned API version and the SDK types differ.

`webhook-event-sweep` (daily, billing on) prunes `processed_webhook_events` after 90 days and stashed events after 7 days (processed) or 30 days (never matched).

### Checkout

The two plan routes are declarations; the purchase is `startProCheckout` (`server/utils/billing/proCheckout.ts`) and `startWorkspaceCheckout` (`server/utils/billing/workspaceCheckout.ts`): a live subscription has its price swapped in place, otherwise a Checkout Session opens. Stripe Tax fields come from `checkoutTaxFields` (`checkoutSession.ts`).

A change of a live subscription names only what changes: a request without `interval` keeps the subscription's billing period, a workspace request without `plan` keeps its plan (`requestedPlan` reads both from Stripe's own price, then from the stored row). After an in-place swap the route writes the new plan, interval and period to the row itself (`recordWorkspacePlanChange`, `recordOwnPlanChange`), so the page that made the change shows it without waiting for the webhook, which writes the same state again. A Pro subscriber switches between monthly and annual billing on the profile page.

### Cancelled subscriptions

A subscription cancelled in the Stripe portal keeps its plan until the period ends. `subscriptionCancelAt` (`stripeEvents/stripeObjects.ts`) reads that date (`cancel_at`, or the period end with `cancel_at_period_end`) from every `customer.subscription.*` event into `users.plan_cancel_at` / `workspace_subscriptions.cancel_at`; it is null while the subscription renews. `/api/user/billing` and the workspace billing overview return it as `cancelAt`, and the UI shows "Ends on" instead of "Renews on".

### Workspace subscriptions

`server/utils/billing/workspaceBilling.ts`, `workspaceStripe.ts` and `workspaceBillingLifecycle.ts`; inviting a member (seat purchase included) is `server/utils/workspaces/inviteMember.ts`:

- Seats = members + open invites; the seat count must stay within `MIN_WORKSPACE_SEATS` and `MAX_WORKSPACE_SEATS` (`shared/config/workspaceSeats.ts`).
- More seats are invoiced and paid immediately (`always_invoice` + `error_if_incomplete`); fewer seats are not credited (`proration_behavior: 'none'`).
- Invites and seat changes of one workspace are serialised by a Valkey lock (`acquireWorkspaceSeatLock`, 409 `billing/seats-busy`).
- Deleting a workspace cancels its subscription first (`endWorkspaceBilling`); if Stripe refuses, nothing is deleted. Account deletion hands the billing role to the longest-serving other admin, or lets the subscription end at the period end when there is none (`handOverBillingAdmin`).
- In an entitled workspace, knowledge and image storage count against the workspace pool instead of the members' personal quotas.

### AI credit top-ups

A paid top-up becomes a row in `ai_credit_grants` (12-month expiry). The LiteLLM budget is the plan budget plus credits (`creditBudgetExtraUsd` in `server/utils/billing/aiCreditBudget.ts`). `/api/ai/credits` therefore reports them apart (`splitPlanAndCreditPoints` in `shared/billing/aiPoints.ts`): `pointsTotal` is the plan's monthly allotment, `planPointsRemaining` what is left of it (what the meter shows), `creditPoints` the bought credits on top, and `pointsRemaining` the sum. The hourly `ai-credit-settlement` job (`runCreditSettlement` in `server/utils/billing/aiCredits.ts`) reads each subject's monthly spend from LiteLLM's spend logs, takes what exceeded the plan budget from the grants, and updates the budgets. Purchases go through `server/utils/billing/topupCheckout.ts`; delayed payment methods are granted on `checkout.session.async_payment_succeeded`, refunds are handled on `charge.refunded`.
