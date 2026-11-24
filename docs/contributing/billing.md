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

Besides storage and member caps, the tiers carry the import caps (`importMaxBytes` per converted file, `importFilesPerJob`, `importBytesPerJob`, `importJobsPerDay` for bulk imports) and the delegated-AI-job caps (`aiJobUnitsPerJob`, `aiJobsPerDay`); `null` means unlimited. The public pricing page shows three cards (Free, Pro, Teams with a Team / Business switch), described in [marketing-site.md](marketing-site.md).

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

`server/utils/billing/stripeClient.ts` pins the API version to `STRIPE_API_VERSION` (`shared/contracts/stripe.ts`), the version of the installed `stripe` SDK's types. The webhook endpoint in the Stripe dashboard renders events in its own API version, so it must be set to the same one; the handlers still read the fields that moved between versions from both places, for events stashed or redelivered from before a bump. Prices are found by lookup key `<prefix>_<plan>_<month|year>_<eur|chf>` (prefix `NUXT_STRIPE_LOOKUP_KEY_PREFIX`), or set explicitly with `NUXT_STRIPE_PRICE_IDS` (`server/utils/billing/stripePrices.ts`). An unknown price is logged and skipped.

A Stripe customer belongs to one subject: a user (personal Pro, `users.stripe_customer_id`) or a workspace (its own customer, `workspace_subscriptions.stripe_customer_id`). Checkout routes on `client_reference_id`: a user id, or `workspace:<id>`.

### Webhook

`POST /api/webhooks/stripe` verifies the signature and calls `dispatchStripeEvent` (`server/utils/billing/stripeWebhook.ts`), which runs in one transaction:

1. **Deduplicate**: insert `event.id` into `processed_webhook_events` with `ON CONFLICT DO NOTHING`; an existing row means a redelivery, answered 200 without re-applying anything.
2. **Stash out-of-order events**: Stripe does not order deliveries. A `customer.subscription.*` or `invoice.*` event for a customer no subject owns yet is stored in `pending_stripe_events`.
3. **Dispatch** to the handler for the event type through the table in `server/utils/billing/stripeEvents/eventHandlers.ts`. The table is the list of handled types (`HANDLED_STRIPE_EVENT_TYPES` is derived from it): an event type without an entry is acknowledged unhandled. One module per event family under `stripeEvents/`: `checkoutCompleted.ts`, `creditTopups.ts` (top-up checkouts, delayed payments, refunds), `subscriptionEvents.ts` (created / updated / deleted), `invoiceEvents.ts` (paid / failed); `billingSubjects.ts` resolves a customer to its user or workspace, `stripeObjects.ts` reads the version-dependent fields. Their writes go through `server/repos/userBilling.ts`, `server/repos/workspaceSubscriptions.ts` and `server/repos/stripeWebhookEvents.ts`.
4. **Drain**: after `checkout.session.completed`, stashed events for that customer are replayed in arrival order.

Only state that is not older than the row's is applied. Stripe redelivers an event the endpoint did not acknowledge for up to three days, so an older `customer.subscription.*` snapshot can arrive after a newer one. Each subject's row stores Stripe's time of the newest subscription state it holds (`users.subscription_event_at`, `workspace_subscriptions.subscription_event_at`): the `created` of the last applied subscription event, or, when the app itself read or changed the subscription (the checkout's live read, an in-place plan, billing-period or seat change), Stripe's time just before that (`stripeResponseTime` in `stripeEvents/eventAge.ts`, the response's `Date` header). An event older than that time is acknowledged and recorded for deduplication but not applied; this covers `customer.subscription.created|updated|deleted`, `invoice.paid` and the events replayed from the stash. An event of the same second applies, because `created` has one-second resolution and two real changes in one second must both land; within one second the delivery order decides.

Only the subscription a row tracks is applied: a late event about an older or cancelled subscription cannot bring a plan back. Version-dependent fields are read through `subscriptionPeriod`, `invoiceSubscriptionId` and `invoiceServicePeriod` (`stripeEvents/stripeObjects.ts`), because the pinned API version and the SDK types differ.

`webhook-event-sweep` (daily, billing on) prunes `processed_webhook_events` after 90 days and stashed events after 7 days (processed) or 30 days (never matched).

### Checkout

The two plan routes are declarations; the purchase is `startProCheckout` (`server/utils/billing/proCheckout.ts`) and `startWorkspaceCheckout` (`server/utils/billing/workspaceCheckout.ts`): a live subscription has its price swapped in place, otherwise a Checkout Session opens. Every Checkout Session (plans and top-ups) takes its tax fields from `checkoutTaxFields` (`checkoutSession.ts`), see [Managed Payments](#managed-payments).

A change that costs money (plan, billing period, more seats) is invoiced at once and sent with `payment_behavior: 'pending_if_incomplete'` (`PAID_CHANGE_PARAMS` in `stripePlanChange.ts`). When the payment goes through, the change is applied and written locally as before. When it needs the buyer (3-D Secure, a declined card), Stripe keeps it as the subscription's `pending_update` and changes nothing: the route writes nothing and answers 402 `billing/payment-pending`, whose `recovery` link is the invoice's hosted page (the client shows it as the toast's button). Paid within about a day, Stripe applies the change and sends `customer.subscription.updated` / `customer.subscription.pending_update_applied`, which write plan, seats and period like any change, and the team budget follows; unpaid, Stripe voids the invoice and drops the change. Plans, seats and AI budgets are therefore never unlocked before they are paid. Seats added this way get the full per-seat budget for the running budget window (the prorated `budgetSeatAdjust` is only written by the immediate path).

A change of a live subscription names only what changes: a request without `interval` keeps the subscription's billing period, a workspace request without `plan` keeps its plan (`requestedPlan` reads both from Stripe's own price, then from the stored row). After an in-place swap the route writes the new plan, interval and period to the row itself (`recordWorkspacePlanChange`, `recordOwnPlanChange`), so the page that made the change shows it without waiting for the webhook, which writes the same state again. A Pro subscriber switches between monthly and annual billing on the profile page.

### Cancelled subscriptions

A subscription cancelled in the Stripe portal keeps its plan until the period ends. `subscriptionCancelAt` (`stripeEvents/stripeObjects.ts`) reads that date (`cancel_at`, or the period end with `cancel_at_period_end`) from every `customer.subscription.*` event into `users.plan_cancel_at` / `workspace_subscriptions.cancel_at`; it is null while the subscription renews. `/api/user/billing` and the workspace billing overview return it as `cancelAt`, and the UI shows "Ends on" instead of "Renews on". A row no subscription event has written (`subscription_event_at` null) gets its end date from Stripe through `subscription-cancel-backfill` (daily, `server/utils/billing/subscriptionCancelBackfill.ts`).

### Overdue payments

A renewal whose payment fails leaves the subscription `past_due` while Stripe retries (or `unpaid`), and the plan keeps running. The status is stored (`users.subscription_status`, `workspace_subscriptions.status`) and both billing payloads carry `paymentOverdue`; the profile and the workspace billing tab show one notice with the way to the Stripe portal. Nothing is downgraded until Stripe ends the subscription.

### Workspace subscriptions

`server/utils/billing/workspaceBilling.ts`, `workspaceStripe.ts` and `workspaceBillingLifecycle.ts`; inviting a member (seat purchase included) is `server/utils/workspaces/inviteMember.ts`:

- Seats = members + open invites; the seat count must stay within `MIN_WORKSPACE_SEATS` and `MAX_WORKSPACE_SEATS` (`shared/config/workspaceSeats.ts`).
- More seats are invoiced and paid immediately (`always_invoice` + `pending_if_incomplete`: they count only once paid); fewer seats are not credited (`proration_behavior: 'none'`).
- Invites and seat changes of one workspace are serialised by a Valkey lock (`acquireWorkspaceSeatLock`, 409 `billing/seats-busy`).
- Deleting a workspace cancels its subscription first (`endWorkspaceBilling`); if Stripe refuses, nothing is deleted. Account deletion hands the billing role to the longest-serving other admin, or lets the subscription end at the period end when there is none (`handOverBillingAdmin`).
- In an entitled workspace, knowledge and image storage count against the workspace pool instead of the members' personal quotas.

### AI credit top-ups

A paid top-up becomes a row in `ai_credit_grants` (12-month expiry). The LiteLLM budget is the plan budget plus credits (`creditBudgetExtraUsd` in `server/utils/billing/aiCreditBudget.ts`). `/api/ai/credits` therefore reports them apart (`splitPlanAndCreditPoints` in `shared/billing/aiPoints.ts`): `pointsTotal` is the plan's monthly allotment, `planPointsRemaining` what is left of it (what the meter shows), `creditPoints` the bought credits on top, and `pointsRemaining` the sum. The hourly `ai-credit-settlement` job (`runCreditSettlement` in `server/utils/billing/aiCredits.ts`) reads each subject's monthly spend from LiteLLM's spend logs, takes what exceeded the plan budget from the grants, and updates the budgets. Purchases go through `server/utils/billing/topupCheckout.ts`; delayed payment methods are granted on `checkout.session.async_payment_succeeded`, refunds are handled on `charge.refunded`.

`NUXT_BILLING_TOPUPS_ENABLED=false` (default `true`) stops selling top-ups while plans stay on sale: Stripe Managed Payments sells stored-value credits only after its written approval, so the hosted service can launch paid plans first (set it as the `NUXT_BILLING_TOPUPS_ENABLED` variable of the GitHub Environment; `infra/render-env.sh` renders it). Off, both top-up checkouts (`/api/billing/topup`, `/api/workspaces/:wsId/billing/topup`) answer 404 `billing/topups-disabled` (`assertTopupsEnabled`), and the client (`useBillingMode().topupsEnabled` / `canBuyTopups`) hides every purchase of AI Points: the packs on the pricing page, the buy buttons on the profile and the workspace billing tab (a balance of earlier purchases stays visible), and "Buy AI Points" in the usage badge and the out-of-points notices, where Pro then sees "they refill next period" plus "Add your own key". Credits already bought keep working and the webhook still records purchases in flight.

### Refund notices

Every `charge.refunded` (a top-up or a plan payment) sends the operator a short email after the webhook's transaction committed (`server/utils/billing/refundNotice.ts`): customer email, plan or pack, amount and currency (and the buyer's own currency when it differed), the refund reason and the Stripe dashboard link. It goes to `NUXT_BILLING_NOTIFY_EMAIL`; without it the refund is only logged. The event-id dedup sends it once per event. Hosted ops alerts (Telegram) are a host-side script the app cannot reach, so the notice is an email.

### Managed Payments

`NUXT_STRIPE_MANAGED_PAYMENTS=true` sells paid plans and top-ups through Stripe Managed Payments: Stripe / Link ("Sold through Link, LLC") is the merchant of record and handles VAT, invoices, receipts, refunds and order support. `checkoutTaxFields` then sends only `managed_payments: { enabled: true }` and none of the parameters Stripe forbids with it (`automatic_tax`, `tax_id_collection`, `customer_update`, `invoice_creation`, `subscription_data.invoice_settings` / `default_tax_rates`, payment-method and shipping fields, `payment_intent_data.statement_descriptor*` / `receipt_email`); quantity, `adjustable_quantity`, metadata, `client_reference_id` and the customer fields stay. It wins over `NUXT_STRIPE_AUTOMATIC_TAX` (Stripe Tax as our own seller), which stays the path without it. Managed Payments is enabled per session, so subscriptions bought before it keep their old setup.

- **Currency.** Adaptive Pricing is always on with it: the session, subscription, invoice and charge keep the price's currency (EUR / CHF); the buyer's local currency appears only in `presentment_details`. The currency guards (`isCurrency` in `creditTopups.ts`, `billing/currency-locked`) therefore keep working unchanged.
- **Plan changes** use `pending_if_incomplete` (above), which Managed Payments subscriptions support; `subscription.default_payment_method` can't be changed through the API.
- **Promotion codes.** A new Pro subscription billed yearly opens Checkout with `allow_promotion_codes: true` (`promotionCodeFields` in `proCheckout.ts`), which Managed Payments supports; monthly, in-place plan changes, top-ups and workspace checkouts never show the field. The codes themselves (coupon, products, duration, expiry) are created by hand in Stripe. A discounted invoice needs nothing of ours: plans are identified by price, never by an amount paid. Covered by `tests/billing-sandbox/proPromotionCode.test.ts`.
- **Account deletion** still calls `customers.del`; if Stripe refuses it for a Managed Payments customer, that is logged and the deletion goes on (Link deletes buyer data under its own policy).
- **UI.** `useBillingMode().managedPayments` shows "Sold through Link (Stripe)" with a link to Link's buyer terms on the pricing page and next to every purchase box (`PaidTermsConsent.vue`). The privacy policy, the Terms and the Paid Plans Terms describe Link as the seller.

### Waitlist launch email

The waitlist's consent text promises one email when paid plans launch. `server/utils/privacy/waitlistLaunch.ts` sends it, from a one-shot CLI the operator runs once after billing is switched on (`scripts/waitlist-launch-email.ts`, bundled into the app image as `cli/waitlist-launch-email.js`):

```sh
docker compose exec app bun cli/waitlist-launch-email.js --code <CODE> --expires <YYYY-MM-DD> --dry-run
docker compose exec app bun cli/waitlist-launch-email.js --code <CODE> --expires <YYYY-MM-DD>
```

Every confirmed sign-up gets the email in its sign-up language (paid plans are live, the link to `/pricing`, the code's 40% off the first year of Pro yearly until the expiry day, this is the only email, the entry is deleted) and its row is deleted right after the send succeeded; unconfirmed sign-ups are deleted without email. A failed send keeps its row (one retry, the run stops after five failures in a row), so running the same command again mails only who is left, never anyone twice. It refuses to run while billing is off, without `NUXT_SITE_URL` and, except for `--dry-run`, in email stub mode (it would delete rows it never mailed). `--dry-run` prints counts, never addresses. Sends are 600 ms apart (`--interval-ms`) to stay under Resend's rate limit. The promotion code itself is created by hand in Stripe (see Managed Payments above).

## Tests

- `tests/unit/billing/subscriptionTransitions.test.ts`: every change request (plan, billing period, seats, cancel, resume) against every state of a personal and a workspace subscription, with Stripe and the database in memory. One rule: a request changes only what it names.
- `tests/nuxt/billingMutationRefresh.test.ts`: every billing change the client can make re-reads what it affects after the server answered. A new mutation gets a row in its table.
- `tests/integration/endpoints/` (`stripeBilling`, `stripeWebhook`, `workspaceBilling`, `aiCredits`): the endpoints and the webhook against `stripe-mock` and fixture events.
- `tests/billing-sandbox/`: the app against Stripe's real test-mode API with test clocks ([testing.md](testing.md#billing-sandbox)).
