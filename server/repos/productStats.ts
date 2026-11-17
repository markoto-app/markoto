import { sql, type SQL } from 'drizzle-orm'
import { useDatabase } from '../db/client'
import type { AdminActor } from './proofs'
import type { Kpi, SeriesPoint, StatsBucket, StatsWindow, SubscriptionGroup } from '~~/shared/contracts/adminStats'
import type { BillingInterval, Currency, PaidPlanName } from '~~/shared/config/pricing'

// Instance-wide aggregates for the admin's product stats
// (`/api/admin/stats/*`). Every function returns counts and sums only,
// never a row about a person. Days are UTC; a window is `[from, to)`.
// Definitions: docs/contributing/admin-metrics.md.

/** A `YYYY-MM-DD` day as the timestamptz of its UTC midnight. */
function utc(day: string): SQL {
  return sql`(${day}::timestamp AT TIME ZONE 'UTC')`
}

/** The UTC bucket start of a timestamptz column. */
function bucketOf(bucket: StatsBucket, column: SQL): SQL {
  return sql`date_trunc(${bucket}, ${column} AT TIME ZONE 'UTC')::date`
}

async function rows<T>(query: SQL): Promise<T[]> {
  return (await useDatabase().execute<Record<string, unknown>>(query)).rows as T[]
}

async function one<T>(query: SQL): Promise<T> {
  return (await rows<T>(query))[0] as T
}

/**
 * Fill a per-bucket count into a gap-free series over the window. `inner`
 * selects `t` (bucket start, date) and `v` for buckets that have data.
 */
async function series(w: StatsWindow, inner: SQL): Promise<SeriesPoint[]> {
  const r = await rows<{ t: string, v: number }>(sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc(${w.bucket}, ${w.from}::date)::date,
        (${w.to}::date - 1),
        ('1 ' || ${w.bucket})::interval
      )::date AS t
    )
    SELECT b.t::text AS t, coalesce(d.v, 0)::float8 AS v
    FROM buckets b LEFT JOIN (${inner}) d ON d.t = b.t
    ORDER BY b.t
  `)
  return r.map(p => ({ t: p.t, v: Number(p.v) }))
}

/** A count in the window and in the window before it. */
async function kpi(w: StatsWindow, count: (from: string, to: string) => SQL): Promise<Kpi> {
  const value = Number((await one<{ n: number }>(count(w.from, w.to))).n)
  const previous = w.prevFrom === null ? null : Number((await one<{ n: number }>(count(w.prevFrom, w.from))).n)
  return { value, previous }
}

/** Day of the first sign-up (start of the `all` range), null on an empty instance. */
export async function firstSignupDay(_by: AdminActor): Promise<string | null> {
  const r = await one<{ day: string | null }>(sql`SELECT (min(created_at) AT TIME ZONE 'UTC')::date::text AS day FROM users`)
  return r.day
}

// Users

export async function userTotals(_by: AdminActor, w: StatsWindow): Promise<{
  registered: number
  pendingDeletion: number
  free: number
  pro: number
  github: number
  google: number
  oidc: number
  sso: number
  activeDay: number
  activeWeek: number
  activeMonth: number
  activeInWindow: number
}> {
  // `last_active_on` is a UTC day; "today" is the window's last day.
  const today = sql`(${w.to}::date - 1)`
  const r = await one<Record<string, string>>(sql`
    SELECT
      count(*) AS registered,
      count(*) FILTER (WHERE deletion_requested_at IS NOT NULL) AS pending_deletion,
      count(*) FILTER (WHERE plan = 'free') AS free,
      count(*) FILTER (WHERE plan = 'pro') AS pro,
      count(*) FILTER (WHERE github_id IS NOT NULL) AS github,
      count(*) FILTER (WHERE google_id IS NOT NULL) AS google,
      count(*) FILTER (WHERE oidc_subject IS NOT NULL) AS oidc,
      (SELECT count(DISTINCT user_id) FROM user_identities) AS sso,
      count(*) FILTER (WHERE last_active_on >= ${today}) AS active_day,
      count(*) FILTER (WHERE last_active_on > ${today} - 7) AS active_week,
      count(*) FILTER (WHERE last_active_on > ${today} - 30) AS active_month,
      count(*) FILTER (WHERE last_active_on >= ${w.from}::date) AS active_in_window
    FROM users
  `)
  return {
    registered: Number(r.registered),
    pendingDeletion: Number(r.pending_deletion),
    free: Number(r.free),
    pro: Number(r.pro),
    github: Number(r.github),
    google: Number(r.google),
    oidc: Number(r.oidc),
    sso: Number(r.sso),
    activeDay: Number(r.active_day),
    activeWeek: Number(r.active_week),
    activeMonth: Number(r.active_month),
    activeInWindow: Number(r.active_in_window)
  }
}

export async function signups(_by: AdminActor, w: StatsWindow): Promise<{ kpi: Kpi, series: SeriesPoint[] }> {
  return {
    kpi: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM users WHERE created_at >= ${utc(from)} AND created_at < ${utc(to)}`),
    series: await series(w, sql`
      SELECT ${bucketOf(w.bucket, sql`created_at`)} AS t, count(*) AS v
      FROM users WHERE created_at >= ${utc(w.from)} AND created_at < ${utc(w.to)} GROUP BY 1`)
  }
}

/** Signed-in people with at least one activity-log row (an edit, comment, restore, ...). */
export async function editors(_by: AdminActor, w: StatsWindow): Promise<{ kpi: Kpi, series: SeriesPoint[] }> {
  return {
    kpi: await kpi(w, (from, to) => sql`
      SELECT count(DISTINCT user_id) AS n FROM activity_log
      WHERE user_id IS NOT NULL AND created_at >= ${utc(from)} AND created_at < ${utc(to)}`),
    series: await series(w, sql`
      SELECT ${bucketOf(w.bucket, sql`created_at`)} AS t, count(DISTINCT user_id) AS v
      FROM activity_log
      WHERE user_id IS NOT NULL AND created_at >= ${utc(w.from)} AND created_at < ${utc(w.to)} GROUP BY 1`)
  }
}

/** Of the accounts created in the window: who created a document, edited, used the in-editor AI. */
export async function activation(_by: AdminActor, w: StatsWindow): Promise<{ cohort: number, createdDoc: number, edited: number, usedAi: number }> {
  // An account created in the window can only have acted after `from`, so
  // the activity / AI lookups stay inside the window (index range scans).
  const r = await one<Record<string, string>>(sql`
    WITH cohort AS (
      SELECT id FROM users WHERE created_at >= ${utc(w.from)} AND created_at < ${utc(w.to)}
    )
    SELECT
      (SELECT count(*) FROM cohort) AS cohort,
      (SELECT count(DISTINCT d.owner_id) FROM documents d JOIN cohort c ON c.id = d.owner_id) AS created_doc,
      (SELECT count(DISTINCT a.user_id) FROM activity_log a JOIN cohort c ON c.id = a.user_id
        WHERE a.user_id IS NOT NULL AND a.created_at >= ${utc(w.from)}) AS edited,
      (SELECT count(DISTINCT m.user_id) FROM ai_session_messages m JOIN cohort c ON c.id = m.user_id
        WHERE m.kind = 'user_prompt' AND m.created_at >= ${utc(w.from)}) AS used_ai
  `)
  return { cohort: Number(r.cohort), createdDoc: Number(r.created_doc), edited: Number(r.edited), usedAi: Number(r.used_ai) }
}

/**
 * Weekly sign-up cohorts starting at `fromWeek` (a Monday): each cohort's
 * size and, per week offset, how many of its accounts edited in that week.
 */
export async function retentionCohorts(_by: AdminActor, fromWeek: string): Promise<{
  sizes: Array<{ week: string, size: number }>
  retained: Array<{ week: string, offset: number, users: number }>
}> {
  const sizes = await rows<{ week: string, size: number }>(sql`
    SELECT ${bucketOf('week', sql`created_at`)}::text AS week, count(*)::int AS size
    FROM users WHERE created_at >= ${utc(fromWeek)} GROUP BY 1 ORDER BY 1`)
  const retained = await rows<{ week: string, offset: number, users: number }>(sql`
    WITH cohort AS (
      SELECT id, ${bucketOf('week', sql`created_at`)} AS week FROM users WHERE created_at >= ${utc(fromWeek)}
    ), acted AS (
      SELECT DISTINCT user_id, ${bucketOf('week', sql`created_at`)} AS week
      FROM activity_log WHERE user_id IS NOT NULL AND created_at >= ${utc(fromWeek)}
    )
    SELECT c.week::text AS week, ((a.week - c.week) / 7)::int AS "offset", count(DISTINCT c.id)::int AS users
    FROM cohort c JOIN acted a ON a.user_id = c.id AND a.week >= c.week
    GROUP BY 1, 2 ORDER BY 1, 2`)
  return {
    sizes: sizes.map(s => ({ week: s.week, size: Number(s.size) })),
    retained: retained.map(r => ({ week: r.week, offset: Number(r.offset), users: Number(r.users) }))
  }
}

// Content

export async function documentStats(_by: AdminActor, w: StatsWindow): Promise<{
  total: number
  owned: number
  anonymous: number
  inWorkspaces: number
  words: number
  created: Kpi
  edited: Kpi
  series: SeriesPoint[]
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE owner_id IS NOT NULL) AS owned,
      count(*) FILTER (WHERE owner_id IS NULL) AS anonymous,
      count(*) FILTER (WHERE workspace_id IS NOT NULL) AS in_workspaces,
      coalesce(sum(word_count), 0) AS words
    FROM documents`)
  return {
    total: Number(t.total),
    owned: Number(t.owned),
    anonymous: Number(t.anonymous),
    inWorkspaces: Number(t.in_workspaces),
    words: Number(t.words),
    created: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM documents WHERE created_at >= ${utc(from)} AND created_at < ${utc(to)}`),
    edited: await kpi(w, (from, to) => sql`
      SELECT count(DISTINCT doc_id) AS n FROM activity_log
      WHERE action = 'edit' AND created_at >= ${utc(from)} AND created_at < ${utc(to)}`),
    series: await series(w, sql`
      SELECT ${bucketOf(w.bucket, sql`created_at`)} AS t, count(*) AS v
      FROM documents WHERE created_at >= ${utc(w.from)} AND created_at < ${utc(w.to)} GROUP BY 1`)
  }
}

export async function workspaceStats(_by: AdminActor, w: StatsWindow): Promise<{
  total: number
  created: Kpi
  guests: number
  memberBuckets: Array<{ bucket: string, workspaces: number }>
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT (SELECT count(*) FROM workspaces) AS total,
      (SELECT count(*) FROM workspace_members WHERE role = 'guest') AS guests`)
  // Members without guests (guests hold no seat).
  const buckets = await rows<{ bucket: string, workspaces: number }>(sql`
    WITH sizes AS (
      SELECT w.workspace_id, count(m.user_id) FILTER (WHERE m.role <> 'guest') AS members
      FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.workspace_id
      GROUP BY w.workspace_id
    )
    SELECT CASE WHEN members <= 1 THEN '1' WHEN members <= 5 THEN '2-5' WHEN members <= 20 THEN '6-20' ELSE '21+' END AS bucket,
      count(*)::int AS workspaces
    FROM sizes GROUP BY 1`)
  const order = ['1', '2-5', '6-20', '21+']
  return {
    total: Number(t.total),
    guests: Number(t.guests),
    created: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM workspaces WHERE created_at >= ${utc(from)} AND created_at < ${utc(to)}`),
    memberBuckets: order.map(bucket => ({ bucket, workspaces: Number(buckets.find(b => b.bucket === bucket)?.workspaces ?? 0) }))
  }
}

export async function storedContentStats(_by: AdminActor, w: StatsWindow): Promise<{
  knowledge: { files: number, ready: number, failed: number, bytes: number, chunks: number, tokens: number, uploaded: Kpi }
  images: { files: number, bytes: number, uploaded: Kpi }
  published: { pages: number, indexable: number, customDomains: number, verifiedDomains: number }
  comments: { total: number, added: Kpi }
  savedThemes: number
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT
      (SELECT count(*) FROM workspace_knowledge) AS k_files,
      (SELECT count(*) FROM workspace_knowledge WHERE status = 'ready') AS k_ready,
      (SELECT count(*) FROM workspace_knowledge WHERE status = 'failed') AS k_failed,
      (SELECT coalesce(sum(size_bytes), 0) FROM workspace_knowledge) AS k_bytes,
      (SELECT coalesce(sum(chunk_count), 0) FROM workspace_knowledge) AS k_chunks,
      (SELECT coalesce(sum(token_count), 0) FROM workspace_knowledge) AS k_tokens,
      (SELECT count(*) FROM uploads WHERE confirmed_at IS NOT NULL) AS i_files,
      (SELECT coalesce(sum(size_bytes), 0) FROM uploads WHERE confirmed_at IS NOT NULL) AS i_bytes,
      (SELECT count(*) FROM published_pages) AS p_pages,
      (SELECT count(*) FROM published_pages WHERE indexable) AS p_indexable,
      (SELECT count(*) FROM custom_domains) AS d_total,
      (SELECT count(*) FROM custom_domains WHERE status = 'verified') AS d_verified,
      (SELECT count(*) FROM document_comments) AS comments,
      (SELECT count(*) FROM themes) AS themes`)
  return {
    knowledge: {
      files: Number(t.k_files),
      ready: Number(t.k_ready),
      failed: Number(t.k_failed),
      bytes: Number(t.k_bytes),
      chunks: Number(t.k_chunks),
      tokens: Number(t.k_tokens),
      uploaded: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM workspace_knowledge WHERE created_at >= ${utc(from)} AND created_at < ${utc(to)}`)
    },
    images: {
      files: Number(t.i_files),
      bytes: Number(t.i_bytes),
      uploaded: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM uploads WHERE confirmed_at >= ${utc(from)} AND confirmed_at < ${utc(to)}`)
    },
    published: { pages: Number(t.p_pages), indexable: Number(t.p_indexable), customDomains: Number(t.d_total), verifiedDomains: Number(t.d_verified) },
    comments: {
      total: Number(t.comments),
      added: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM document_comments WHERE created_at_ms >= ${utc(from)} AND created_at_ms < ${utc(to)}`)
    },
    savedThemes: Number(t.themes)
  }
}

// AI (app side; spend comes from LiteLLM's database, `litellmSpend.ts`)

export async function aiAppStats(_by: AdminActor, w: StatsWindow): Promise<{
  byok: { users: number, chat: number, image: number, transcription: number }
  mcp: { activeTokens: number, sessions: Kpi }
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT
      (SELECT count(DISTINCT user_id) FROM user_ai_providers) AS byok_users,
      (SELECT count(DISTINCT user_id) FROM user_ai_providers WHERE capability = 'chat') AS byok_chat,
      (SELECT count(DISTINCT user_id) FROM user_ai_providers WHERE capability = 'image') AS byok_image,
      (SELECT count(DISTINCT user_id) FROM user_ai_providers WHERE capability = 'transcription') AS byok_transcription,
      (SELECT count(*) FROM mcp_personal_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS mcp_tokens`)
  return {
    byok: { users: Number(t.byok_users), chat: Number(t.byok_chat), image: Number(t.byok_image), transcription: Number(t.byok_transcription) },
    mcp: {
      activeTokens: Number(t.mcp_tokens),
      sessions: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM mcp_sessions WHERE started_at >= ${utc(from)} AND started_at < ${utc(to)}`)
    }
  }
}

// Revenue

/** Statuses during which a subscription is billed (a failed payment is being retried while `past_due`). */
const BILLED = sql`('active', 'past_due')`

/**
 * Live paid subscriptions grouped by price: Pro on the user rows, Team /
 * Business on the workspace rows. A subscription without a recorded
 * interval is judged by its period length, without a currency as EUR (the
 * column default of the workspace rows). `status` picks billed or trialing.
 */
export async function subscriptionGroups(_by: AdminActor, status: 'billed' | 'trialing'): Promise<SubscriptionGroup[]> {
  const statuses = status === 'billed' ? BILLED : sql`('trialing')`
  const r = await rows<{ plan: PaidPlanName, currency: Currency, interval: BillingInterval, subscriptions: number, units: number }>(sql`
    SELECT 'pro' AS plan, coalesce(billing_currency, 'eur') AS currency,
      coalesce(billing_interval, CASE WHEN plan_valid_until - stripe_current_period_start > interval '32 days' THEN 'year' ELSE 'month' END) AS interval,
      count(*)::int AS subscriptions, count(*)::int AS units
    FROM users
    WHERE plan = 'pro' AND stripe_subscription_id IS NOT NULL AND subscription_status IN ${statuses}
      AND plan_valid_until > now()
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT plan, currency, interval, count(*)::int AS subscriptions, sum(seats)::int AS units
    FROM workspace_subscriptions
    WHERE status IN ${statuses} AND (valid_until IS NULL OR valid_until > now())
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`)
  return r.map(g => ({ ...g, subscriptions: Number(g.subscriptions), units: Number(g.units) }))
}

/** Billed subscriptions that are set to end (cancelled, still running). */
export async function cancellingGroups(_by: AdminActor): Promise<SubscriptionGroup[]> {
  const r = await rows<{ plan: PaidPlanName, currency: Currency, interval: BillingInterval, subscriptions: number, units: number }>(sql`
    SELECT 'pro' AS plan, coalesce(billing_currency, 'eur') AS currency,
      coalesce(billing_interval, CASE WHEN plan_valid_until - stripe_current_period_start > interval '32 days' THEN 'year' ELSE 'month' END) AS interval,
      count(*)::int AS subscriptions, count(*)::int AS units
    FROM users
    WHERE plan = 'pro' AND stripe_subscription_id IS NOT NULL AND subscription_status IN ${BILLED}
      AND plan_valid_until > now() AND plan_cancel_at IS NOT NULL
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT plan, currency, interval, count(*)::int, sum(seats)::int
    FROM workspace_subscriptions
    WHERE status IN ${BILLED} AND (valid_until IS NULL OR valid_until > now()) AND cancel_at IS NOT NULL
    GROUP BY 1, 2, 3`)
  return r.map(g => ({ ...g, subscriptions: Number(g.subscriptions), units: Number(g.units) }))
}

export async function revenueCounts(_by: AdminActor, w: StatsWindow): Promise<{
  pastDue: number
  topups: Array<{ currency: Currency, amount: number, count: number }>
  waitlist: { confirmed: number, unconfirmed: number, newConfirmed: Kpi }
  planMix: { free: number, pro: number, team: number, business: number }
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT
      (SELECT count(*) FROM users WHERE plan = 'pro' AND subscription_status = 'past_due') +
      (SELECT count(*) FROM workspace_subscriptions WHERE status = 'past_due') AS past_due,
      (SELECT count(*) FROM waitlist_signups WHERE confirmed_at IS NOT NULL) AS wl_confirmed,
      (SELECT count(*) FROM waitlist_signups WHERE confirmed_at IS NULL) AS wl_unconfirmed,
      (SELECT count(*) FROM users WHERE plan = 'free') AS free,
      (SELECT count(*) FROM users WHERE plan = 'pro') AS pro,
      (SELECT count(*) FROM workspace_subscriptions WHERE plan = 'team' AND status IN ${BILLED}) AS team,
      (SELECT count(*) FROM workspace_subscriptions WHERE plan = 'business' AND status IN ${BILLED}) AS business`)
  // Paid amounts are minor units (cents / Rappen); refunds are in USD credit
  // and not reflected here.
  const topups = await rows<{ currency: Currency, amount: number, count: number }>(sql`
    SELECT currency, (sum(amount_paid) / 100.0)::float8 AS amount, count(*)::int AS count
    FROM ai_credit_grants WHERE created_at >= ${utc(w.from)} AND created_at < ${utc(w.to)}
    GROUP BY 1 ORDER BY 1`)
  return {
    pastDue: Number(t.past_due),
    topups: topups.map(r => ({ currency: r.currency, amount: Number(r.amount), count: Number(r.count) })),
    waitlist: {
      confirmed: Number(t.wl_confirmed),
      unconfirmed: Number(t.wl_unconfirmed),
      newConfirmed: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM waitlist_signups WHERE confirmed_at >= ${utc(from)} AND confirmed_at < ${utc(to)}`)
    },
    planMix: { free: Number(t.free), pro: Number(t.pro), team: Number(t.team), business: Number(t.business) }
  }
}

// Operations

export async function opsCounts(_by: AdminActor, w: StatsWindow): Promise<{
  databaseBytes: number
  imageBytes: number
  knowledgeBytes: number
  publishedPages: number
  exports: Record<'queued' | 'running' | 'ready' | 'failed' | 'expired', number>
  abuse: { open: number, acknowledged: number, actioned: number, dismissed: number, received: Kpi }
  pendingDeletion: number
  knowledgeFailed: number
  restrictedDocuments: number
  openInvites: number
  pendingStripeEvents: number
}> {
  const t = await one<Record<string, string>>(sql`
    SELECT
      pg_database_size(current_database()) AS db_bytes,
      (SELECT coalesce(sum(size_bytes), 0) FROM uploads) AS image_bytes,
      (SELECT coalesce(sum(size_bytes), 0) FROM workspace_knowledge) AS knowledge_bytes,
      (SELECT count(*) FROM published_pages) AS published,
      (SELECT count(*) FROM users WHERE deletion_requested_at IS NOT NULL) AS pending_deletion,
      (SELECT count(*) FROM workspace_knowledge WHERE status = 'failed') AS knowledge_failed,
      (SELECT count(*) FROM documents WHERE moderation_restricted_at IS NOT NULL) AS restricted,
      (SELECT count(*) FROM workspace_invites WHERE expires_at > now()) AS invites,
      (SELECT count(*) FROM pending_stripe_events WHERE NOT processed) AS stripe_pending`)
  const exp = await rows<{ status: string, n: number }>(sql`SELECT status, count(*)::int AS n FROM data_export_jobs GROUP BY 1`)
  const abuse = await rows<{ status: string, n: number }>(sql`SELECT status, count(*)::int AS n FROM abuse_reports GROUP BY 1`)
  const count = (list: Array<{ status: string, n: number }>, status: string): number => Number(list.find(r => r.status === status)?.n ?? 0)
  return {
    databaseBytes: Number(t.db_bytes),
    imageBytes: Number(t.image_bytes),
    knowledgeBytes: Number(t.knowledge_bytes),
    publishedPages: Number(t.published),
    exports: {
      queued: count(exp, 'queued'),
      running: count(exp, 'running'),
      ready: count(exp, 'ready'),
      failed: count(exp, 'failed'),
      expired: count(exp, 'expired')
    },
    abuse: {
      open: count(abuse, 'open'),
      acknowledged: count(abuse, 'acknowledged'),
      actioned: count(abuse, 'actioned'),
      dismissed: count(abuse, 'dismissed'),
      received: await kpi(w, (from, to) => sql`SELECT count(*) AS n FROM abuse_reports WHERE created_at >= ${utc(from)} AND created_at < ${utc(to)}`)
    },
    pendingDeletion: Number(t.pending_deletion),
    knowledgeFailed: Number(t.knowledge_failed),
    restrictedDocuments: Number(t.restricted),
    openInvites: Number(t.invites),
    pendingStripeEvents: Number(t.stripe_pending)
  }
}

export type SubscriptionStep = 'started' | 'changed' | 'cancel_scheduled' | 'cancel_revoked' | 'ended'

/** Subscription history steps in [from, to), grouped by step and price (`subscription_events`). */
export async function subscriptionSteps(_by: AdminActor, from: string, to: string): Promise<Array<SubscriptionGroup & { kind: SubscriptionStep }>> {
  const r = await rows<{ kind: SubscriptionStep, plan: PaidPlanName, currency: Currency, interval: BillingInterval, subscriptions: number, units: number }>(sql`
    SELECT kind, plan, currency, interval, count(*)::int AS subscriptions, sum(seats)::int AS units
    FROM subscription_events
    WHERE occurred_at >= ${utc(from)} AND occurred_at < ${utc(to)}
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`)
  return r.map(g => ({ ...g, subscriptions: Number(g.subscriptions), units: Number(g.units) }))
}

/** Subscriptions started and ended per time bucket of the window. */
export async function subscriptionStepSeries(_by: AdminActor, w: StatsWindow): Promise<{ started: SeriesPoint[], ended: SeriesPoint[] }> {
  const step = (kind: SubscriptionStep) => series(w, sql`
    SELECT ${bucketOf(w.bucket, sql`occurred_at`)} AS t, count(*) AS v
    FROM subscription_events
    WHERE kind = ${kind} AND occurred_at >= ${utc(w.from)} AND occurred_at < ${utc(w.to)} GROUP BY 1`)
  return { started: await step('started'), ended: await step('ended') }
}
