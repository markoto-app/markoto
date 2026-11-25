# Admin product stats: metric definitions

The admin area (`/admin`, "Admin" in the account menu of an admin; its pages are listed in `app/utils/admin/adminSections.ts`) holds the stats page `/admin/stats` (tabs Overview, Users, Funnel, Content, AI, Revenue, Operations) and the one-page investor summary `/admin/stats/investor`. The billing check `/admin/billing-consistency` is described in [billing.md](billing.md#billing-consistency-check). Both show product numbers of one instance. This page defines every number, so a figure in an investor update can be reproduced from the database.

- Endpoints: `GET /api/admin/stats/{overview,users,funnel,content,ai,revenue,ops}?range=7|30|90|365|all[&bucket=day|week|month]`, admin only (`allow.admin()`).
- Code: SQL in `server/repos/productStats.ts` and `server/repos/litellmSpend.ts`, assembly in `server/utils/adminStats/productStats.ts`, shapes and arithmetic in `shared/contracts/adminStats.ts`.
- Every response holds counts and sums only; no response names a person.
- Answers are cached in the app process for 60 seconds (`server/utils/adminStats/statsCache.ts`).

## Windows and comparisons

- All days are UTC. A window is `[from, to)`: `to` is tomorrow, so today counts. `range=30` is today and the 29 days before.
- Each KPI with a change compares the window with the equally long window right before it. `all` has no comparison.
- `all` starts at the first sign-up, at most 60 months back.
- Count charts step in whole numbers (at least 0 to 4 on the axis); money charts keep decimals.
- Time series: daily points for 7 / 30 / 90 days, weekly (Monday) for 12 months, monthly for all time; buckets without data are 0. The investor summary asks for 12 months with monthly points.

## Users

| Metric | Definition |
|---|---|
| Accounts | Rows in `users`, including accounts in their 30-day deletion grace period (shown separately as "Deletion pending"). Deleted accounts are gone and not counted. |
| New sign-ups | Accounts whose `created_at` falls in the window. |
| Active today / 7 days / 30 days (DAU / WAU / MAU) | Accounts whose `users.last_active_on` is today, within the last 7 days, within the last 30 days. `last_active_on` is the last UTC day the account made a signed-in request (any request whose session was validated); it is written at most once per account per day. It holds only the last day, so these are current numbers without a history or a previous-period comparison. |
| Active in period | Accounts with `last_active_on` inside the window. |
| Stickiness | DAU / MAU in percent. |
| People who edited | Distinct signed-in `activity_log.user_id` with any row in the window (edit, comment, restore, title or design change). Anonymous edits and AI agents are not counted. This is the engagement number with a history (series and comparison). |
| Activation | Of the accounts created in the window: how many own a document (`documents.owner_id`), have an activity-log row, and sent at least one in-editor AI prompt (`ai_session_messages.kind = 'user_prompt'`, kept 90 days). |
| Retention by weekly cohort | Accounts grouped by sign-up week (12 weeks); cell W*k* = share of the cohort with an activity-log row in the *k*-th week after the sign-up week (W0 = sign-up week). Weeks that have not started are empty. |
| Sign-in providers | Accounts with a GitHub id, a Google id, a generic OIDC identity, a workspace SSO identity (`user_identities`). An account with several counts in each. |
| Plans | `users.plan` (free / pro), as stored; with billing off every account is treated as free at runtime. |

The accounts chart in the investor summary is the running total of sign-ups per month, shifted so the last point equals today's account count. Deleted accounts are not in it.

## Funnel by source

The Funnel tab answers "of the people a launch or a channel brought, how many wrote something, signed up, started a checkout and pay now", per acquisition source. It is built for launch days (for example the Product Hunt launch with `https://markoto.app/?ref=producthunt`): pick the 7-day range on the day after the launch and read the Product Hunt row.

**Sources.** One category of a fixed list (`shared/analytics/acquisition.ts`): `producthunt`, `hackernews`, `google`, `github`, `other`, and `direct` for no source. The browser derives it from the landing URL, in this order: `?ref=` (our own launch links; known labels like `producthunt`, `ph`, `hn` map to their source, any other label is `other`), `utm_source` (same mapping), then the referring site (`producthunt.com`, `news.ycombinator.com`, `google.*`, `github.com`; any other external site is `other`). Only the category leaves the browser, never the URL, label or referrer. A visitor who is signed in when the page loads gets no referrer-derived source (after a sign-in the referrer is the provider's page). Use `?ref=<source>` on every link you post; a bare link from a site that sends no referrer counts as direct.

**Where it is stored.** Only where visitor statistics are on (`NUXT_PUBLIC_ANALYTICS_WEBSITE_ID`) and never for a request with Global Privacy Control or Do Not Track:

- `documents.acquisition_source`: the creating visit's source for an anonymous document (body field `acquisitionSource` of `POST /api/docs`); the account's source for a signed-in creator.
- `users.acquisition_source`: written once at sign-up. The sign-in link carries `?ref=<source>`; the start leg parks it in Valkey under the OAuth `state` (15 minutes), the callback of a NEW account stores it and adds `signed_up_source=<source>` to the landing URL for the browser's `signup_completed` event. GitHub and Google sign-in only.
- `users.checkout_started_at`: the first time the account opened a paid checkout (Pro or a workspace plan), set when the Stripe Checkout Session is created.

**Steps** (window `[from, to)`, UTC days):

| Step | Definition | Source |
|---|---|---|
| Visits | Umami visits (`website_event.visit_id`) whose first page view falls in the window, classified by that page view's query (`ref`, `utm_source`) and referring domain with the same rules as the browser. "n/a" when analytics is off or the Umami database cannot be read; undercounted by ad blockers. | Umami database |
| First document | People whose first document was created in the window: accounts (`owner_id`) and anonymous browsers (`anon_creator_key_hash`), each counted once, by the source on that first document. An anonymous visitor who later signs up and writes again counts twice (as a browser and as an account). | `documents` |
| Sign-ups | Accounts created in the window, by `users.acquisition_source`. | `users` |
| Checkout started | Of those accounts: `checkout_started_at` set (at any time up to now). | `users` |
| Paying now | Of those accounts: a billed Pro subscription (as in Revenue), or billing admin of a billed Team / Business workspace subscription. | `users`, `workspace_subscriptions` |

Sign-ups, checkouts and paying accounts are one cohort (the accounts created in the window), so their rates are true conversions. Visits and first documents are counted in the window on their own; the percentages next to each count are the share of the step before (they can exceed 100 % where a step has more sources than the one before, for example documents of people whose visit Umami never saw). The table downloads as CSV with the raw counts.

**In Umami.** Page views carry `ref=<source>` in their query (next to the UTM parameters), and the events `doc_created`, `signup_started`, `signup_completed`, `checkout_started` and `checkout_completed` carry the event property `ref` (the source, `direct` when none). The funnel `launchFunnel` in `shared/analytics/events.ts` (`/` → `doc_created` → `signup_completed` → `checkout_started` → `checkout_completed`) can be set up in Umami (Reports → Funnel) and filtered by `ref`. Umami's numbers are per visit and lower than the database's wherever ad blockers or Global Privacy Control stop the requests; the database numbers are the ones to report.

## Content

| Metric | Definition |
|---|---|
| Documents | Rows in `documents`; "with an owner" vs "anonymous" (`owner_id` null); "in workspaces" (`workspace_id` set). Anonymous documents are deleted 30 days after their last edit, so they are a moving number. |
| Words written | Sum of `documents.word_count` as last reported by the editor. |
| Documents created | `documents.created_at` in the window. |
| Documents edited | Distinct `doc_id` with an `edit` activity row in the window (anonymous edits included). |
| Workspaces | Rows in `workspaces`; created in the window; members per workspace without guests (1, 2-5, 6-20, 21+); guests = `workspace_members.role = 'guest'`. |
| Knowledge base | Rows in `workspace_knowledge` (all statuses, failed separately), sum of `size_bytes` (size of the uploaded originals, which are deleted after processing), `chunk_count`, `token_count`; uploaded = `created_at` in the window. |
| Images | Confirmed `uploads` rows and their bytes; uploaded = `confirmed_at` in the window. |
| Publishing | `published_pages` (and those open to search engines), `custom_domains` (all, and verified). |
| Comments | Rows in `document_comments` (a mirror of the documents' comment threads); added = `created_at_ms` in the window. |

## AI

Cost comes from LiteLLM's `LiteLLM_SpendLogs` (its own database) and, for older days, from the daily rollup `ai_spend_daily`.

- **Why 90 days.** LiteLLM itself deletes nothing (no retention is configured in `deploy/config/litellm/config.yaml`). The 90 days are ours: `spend-logs-sweep` (`server/utils/litellm/spendLogsSweep.ts`, the constant `SPEND_LOG_RETENTION_DAYS`, not configurable) deletes older rows, matching the 90-day retention of `ai_assistance` in `server/legal/lawfulBasis.ts`. Each row names the user, the workspace and the document (`request_tags`) and the key, so it is personal data and kept only as long as the free-pool, budget and credit accounting needs it.
- **Rollup.** `ai-spend-rollup` (every 6 hours, advisory-locked) recomputes every finished day the raw rows still fully cover (the last 88 days) into `ai_spend_daily`: per UTC day, feature tag and model, the cost, the request count, the number of distinct users and whether the call was platform-paid (not `byok/*`). No user, workspace, document or key id. The first run backfills everything the logs hold; a day keeps its last full count after its raw rows are gone. The rollup is kept indefinitely.
- **Reading.** Days older than the last 88 come from the rollup, the rest from the raw rows, so a 12-month or all-time chart is seamless from the first rolled-up day on. Comparisons with the previous window are shown when the history covers it.
- **People using AI** needs the raw rows (a daily count of distinct users cannot be added up over days), so it covers at most the last 90 days; the page says from which day.

| Metric | Definition |
|---|---|
| AI cost | Sum of `spend` (USD) of the rows in the window. Each request counts once. LiteLLM's `/spend/tags` adds a request's cost to every tag it carries (feature, user, workspace, document) and over-counts when summed; it is not used here. |
| Cost by feature | Each row is assigned to its `feature:*` tag (the first in sort order if a row ever had two); rows without one are "other". Same query as the AI spend page (`spendByFeature`). |
| AI requests | Rows in the window. |
| People using AI | Distinct `user:<id>` tags in the window whose account still exists. The spend logs keep the calls of accounts deleted since (90 days), so they are matched against `users` (`countExistingUsers`); the number can never exceed the accounts. Calls on a user's own key (bring your own key) are logged at zero cost and counted here too. |
| Cost per AI user / per active user | AI cost / everyone with a call in the window (deleted accounts included, as their cost is in the sum); AI cost / accounts active in the window (`last_active_on`). |
| Free AI pool | Cost this calendar month (UTC) of the LiteLLM team `markoto-free-tier` against `NUXT_FREE_TIER_TOTAL_BUDGET_USD`; the team's budget resets on the 1st. "No shared limit" when the variable is unset. |
| Own AI key | Accounts with at least one `user_ai_providers` row (also per capability). |
| MCP | Personal access tokens not revoked and not expired; MCP sessions started in the window. |

## Revenue

Revenue works with billing on or off. It reads the subscription rows the Stripe webhook keeps, not Stripe itself.

| Metric | Definition |
|---|---|
| Paying subscriptions | Pro: `users.plan = 'pro'` with a Stripe subscription id, status `active` or `past_due` and `plan_valid_until` in the future. Team / Business: `workspace_subscriptions` with status `active` or `past_due` and `valid_until` null or in the future. Trials (`trialing`) are counted separately and are not revenue. |
| MRR | Per currency (EUR, CHF), never converted: Σ list price × units, with yearly prices divided by 12. Units are 1 for Pro and the seats for Team / Business. A subscription without a stored interval is judged by its period length (more than 32 days = yearly); one without a stored currency counts as EUR. |
| ARR | 12 × MRR. |
| List prices | With billing on, the live Stripe prices found by lookup key (`server/utils/billing/stripePrices.ts`); with billing off (or if Stripe cannot be reached), the planned prices (`shared/config/pricing.ts`, `TIER_<PLAN>_PRICE_<CUR>[_YEAR]`). |
| Set to end | Paying subscriptions with a cancellation date (`users.plan_cancel_at`, `workspace_subscriptions.cancel_at`), with the MRR they carry. |
| Subscriptions started / cancellations scheduled / ended | Rows of the subscription history `subscription_events` in the window, with the window before for comparison. New MRR and lost MRR are the started and ended subscriptions valued like MRR. |
| AI credit purchases | `ai_credit_grants` created in the window: paid amount per currency (refunds not subtracted). |
| Waitlist | `waitlist_signups` confirmed / not confirmed; new = `confirmed_at` in the window. |
| Plan mix | Accounts per personal plan; Team / Business workspaces with a billed subscription. |

MRR, ARR and the subscription counts are gross at list price: discounts and coupons, taxes and payment fees are not deducted.

### Subscription history

`subscription_events` is append-only and written by the Stripe webhook in the event's transaction (`server/utils/billing/stripeEvents/subscriptionHistory.ts`), for Pro on a user and Team / Business on a workspace:

| Step | Stripe event |
|---|---|
| started | `customer.subscription.created` |
| changed | `customer.subscription.updated` whose `previous_attributes` name the items, quantity or plan (price or seats changed) |
| cancel_scheduled / cancel_revoked | `customer.subscription.updated` whose `previous_attributes` name `cancel_at_period_end` or `cancel_at`; scheduled when the subscription now has an end date, revoked when not |
| ended | `customer.subscription.deleted` |

Each row holds plan, interval, currency, seats and Stripe's event time. A redelivered event adds nothing (unique per event and step), and a subscription starts and ends once. Steps are recorded for a known customer and one of our prices, also when the event is older than the stored state (a `created` event its checkout overtook still marks the start), but not for a workspace's duplicate or already-ended subscription. A dedicated table rather than `audit_log`: audit rows are deleted after two years, carry IPs and actors, and the webhook writes no audit rows; revenue history must outlive both and stay countable by plan and price. The migration backfills the workspace subscriptions (start from `created_at`, end from `updated_at` of ended rows); Pro history starts with this version. On account deletion the rows lose the user and the Stripe subscription id and stay as anonymous history (lawful basis `billing`, category `subscription_history`; in the data export as the file billing/subscription_history.json).

### Combined CHF and the estimated contribution

All estimates are labelled "estimated" on the page. The assumptions are configuration (`NUXT_STATS_*`, `docs/reference/configuration.md`):

| Variable | Default | Meaning |
|---|---|---|
| `NUXT_STATS_EUR_CHF_RATE` | 0.93 | EUR to CHF for every combined CHF figure |
| `NUXT_STATS_USD_CHF_RATE` | 0.8 | USD to CHF for the AI cost |
| `NUXT_STATS_TAX_PCT` | 8.1 | Tax contained in the tax-inclusive prices (Swiss VAT). With Stripe Managed Payments, Stripe sells as merchant of record and removes the buyer's local tax before paying out; set the average rate of your buyers. |
| `NUXT_STATS_PAYMENT_FEE_PCT` | 3.5 | Payment fee in percent of the charged amount (Stripe Managed Payments) |
| `NUXT_STATS_PAYMENT_FEE_FIXED` | 0.3 | Fixed fee per charge, in the charge's currency |

Per currency, per month:

```
gross   = MRR (list prices include tax)
tax     = gross x rate / (100 + rate)
charges = monthly subscriptions + yearly subscriptions / 12
fees    = gross x fee% / 100 + charges x fixed fee
net     = gross - tax - fees
```

In CHF: `MRR (CHF) = MRR CHF + MRR EUR x EUR rate`, `ARR (CHF) = 12 x MRR (CHF)`, and

```
contribution = sum of the nets in CHF - platform-paid AI cost of the last 30 days x USD rate
```

The AI cost is all spend-log cost of the last 30 days. Calls on a user's own key run through the zero-cost `byok/*` deployment, so they add nothing. The contribution leaves out hosting, storage, e-mail and other fixed costs, refunds, discounts and currency fluctuations.

## Operations

| Metric | Definition |
|---|---|
| Database size | `pg_database_size(current_database())` of the app database (without LiteLLM's database). |
| Image storage | Sum of `uploads.size_bytes`, pending uploads included. |
| Knowledge size | Sum of `workspace_knowledge.size_bytes`. |
| Data exports | `data_export_jobs` per status. |
| Abuse reports | `abuse_reports` per status; received = `created_at` in the window. |
| Other | Accounts pending deletion, failed knowledge files, moderation-restricted documents, open workspace invitations (not expired), Stripe events waiting for their customer (`pending_stripe_events`). |

## Privacy

New personal data, privacy policy (current version in `shared/legal/versions.ts`):

- `users.last_active_on` (a date, overwritten daily, no history), under `account_authentication` in `server/legal/lawfulBasis.ts`; in the data export (`profile.json`), deleted with the account. Admins see only counts built from it.
- The subscription history `subscription_events`, under `billing` (category `subscription_history`); in the data export, anonymised on account deletion.
- `users.acquisition_source`, `users.checkout_started_at` and `documents.acquisition_source` (one category of a fixed list, the first checkout time), under `acquisition_measurement` (shown only where analytics is on); the account's two columns in the data export (`profile.json`), gone with the account or document.

`ai_spend_daily` holds no personal data.
