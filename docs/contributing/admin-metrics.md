# Admin product stats: metric definitions

The admin page `/admin/stats` (tabs Overview, Users, Content, AI, Revenue, Operations) and the one-page investor summary `/admin/stats/investor` show product numbers of one instance. This page defines every number, so a figure in an investor update can be reproduced from the database.

- Endpoints: `GET /api/admin/stats/{overview,users,content,ai,revenue,ops}?range=7|30|90|365|all[&bucket=day|week|month]`, admin only (`allow.admin()`).
- Code: SQL in `server/repos/productStats.ts` and `server/repos/litellmSpend.ts`, assembly in `server/utils/adminStats/productStats.ts`, shapes and arithmetic in `shared/contracts/adminStats.ts`.
- Every response holds counts and sums only; no response names a person.
- Answers are cached in the app process for 60 seconds (`server/utils/adminStats/statsCache.ts`).

## Windows and comparisons

- All days are UTC. A window is `[from, to)`: `to` is tomorrow, so today counts. `range=30` is today and the 29 days before.
- Each KPI with a change compares the window with the equally long window right before it. `all` has no comparison.
- `all` starts at the first sign-up, at most 60 months back.
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

Cost comes from LiteLLM's `LiteLLM_SpendLogs` (its own database), which keeps 90 days. A window reaching further back covers only the last 90 days (the page says from which day) and has no comparison when the previous window is no longer covered.

| Metric | Definition |
|---|---|
| AI cost | Sum of `spend` (USD) of the rows in the window. Each request counts once. LiteLLM's `/spend/tags` adds a request's cost to every tag it carries (feature, user, workspace, document) and over-counts when summed; it is not used here. |
| Cost by feature | Each row is assigned to its `feature:*` tag (the first in sort order if a row ever had two); rows without one are "other". Same query as the AI spend page (`spendByFeature`). |
| AI requests | Rows in the window. |
| People using AI | Distinct `user:*` tags in the window. Calls on a user's own key (bring your own key) are logged at zero cost and counted here too. |
| Cost per AI user / per active user | AI cost / people using AI; AI cost / accounts active in the window (`last_active_on`). |
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
| Workspace plans ended | `workspace_subscriptions` in `canceled`, `incomplete_expired` or `unpaid` whose `updated_at` falls in the window. A Pro subscription that ends resets its user row, so ended Pro plans cannot be counted afterwards. |
| AI credit purchases | `ai_credit_grants` created in the window: paid amount per currency (refunds not subtracted). |
| Waitlist | `waitlist_signups` confirmed / not confirmed; new = `confirmed_at` in the window. |
| Plan mix | Accounts per personal plan; Team / Business workspaces with a billed subscription. |

All revenue is gross at list price: discounts and coupons, taxes, and payment fees are not deducted. To estimate net revenue, subtract the payment provider's fees (for Stripe Managed Payments, 3.5 % plus the per-transaction fee) outside this page.

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

The only new personal data is `users.last_active_on` (a date, overwritten daily, no history), declared under `account_authentication` in `server/legal/lawfulBasis.ts` (privacy policy v14) and included in the data export (`profile.json`). It is deleted with the account. Admins see only counts built from it.
