// Posts activity events to the Nuxt app's internal endpoint.
// Fire-and-forget — failures are logged but never block Y.js sync.

import { injectTraceHeaders, captureException } from './sentry'
import { syncEnv } from './env'

const APP_URL = syncEnv().sync.appUrl
const INTERNAL_SECRET = syncEnv().auth.internalApiSecret

// Mirror of the app-side ActivityAction union. Kept in lockstep with
// server/repos/activity.ts; the internal endpoint validates the action
// against its own allowlist.
type ActivityAction
  = | 'edit' | 'join' | 'leave'
    | 'comment.added' | 'comment.replied'
    | 'comment.resolved' | 'comment.reopened' | 'comment.deleted'
    | 'theme.changed' | 'title.changed' | 'ai.tool'

type ActivityEvent = {
  docId: string
  /** Optional user id — drives avatar JOIN on the read endpoint. */
  userId?: number | null
  userName: string | null
  /**
   * Synthetic-principal label for agent-driven rows (`'ai:assistant:{sid}'`,
   * `'mcp:{sid}'`). NULL for human edits. The app-side enrichment in
   * `listRecentActivity` uses this to JOIN to ai_sessions / mcp_sessions
   * → users so the activity feed can render "Joel via Claude Desktop"
   * for agent rows. See `server/db/schema.ts` activity_log.actor_principal
   * column comment.
   */
  actorPrincipal?: string | null
  /**
   * Anonymous editors only: the random per-tab avatar token their
   * awareness broadcasts (`user.avatarSeed`), so the Activity Log shows
   * the same face as the presence bar. Null for everyone else.
   */
  actorAvatarSeed?: string | null
  action: ActivityAction
  wordCount?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
  metadata?: Record<string, unknown> | null
  /**
   * Boundary y-postgresql row ids around the store event that produced
   * this activity. Stamped on the row so the diff endpoint can replay
   * the doc state on either side. Optional — comment-only events may
   * not have meaningful boundaries to attach.
   */
  yjsDocIdBefore?: number | null
  yjsDocIdAfter?: number | null
}

export async function logActivity(event: ActivityEvent): Promise<void> {
  if (!APP_URL || !INTERNAL_SECRET) {
    // Silent no-op if not configured — dev setups without activity logging still work
    return
  }

  try {
    await fetch(`${APP_URL}/api/internal/activity`, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      }),
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    })
  } catch (e) {
    console.warn(`[activity-logger] Failed to log ${event.action} for ${event.docId}:`, e instanceof Error ? e.message : e)
    // App-side activity loss is operationally interesting — a steady
    // trickle means the internal endpoint or its auth path is broken.
    // Defensive try/catch so a Sentry transport hiccup never blocks
    // the next event flow.
    try {
      captureException(e, {
        tags: {
          component: 'activity-logger',
          event: 'post_failed',
          action: event.action
        }
      })
    } catch { /* swallow — telemetry must never throw */ }
  }
}

/** Identity of the authenticated connection an awareness client id was
 *  last received on — taken from that connection's JWT, never from the
 *  awareness payload. See `awareness-identity.ts`. */
export interface VerifiedIdentity {
  userId: string
  userName: string | null
  /** Anonymous writers only: the avatar token their awareness carries. */
  avatarSeed?: string
}

/**
 * Heuristic attribution for a store window with no tracked editor (cold
 * doc / restart / Valkey down): the writer whose awareness state was
 * updated most recently. y-codemirror.next updates awareness on every
 * cursor move / keystroke, so the latest awareness update is a strong
 * signal for "who just edited this". Ordered by the guard's monotonic
 * `seq` (see awareness-guard.ts), not by wall-clock ms, so two updates
 * in the same millisecond still have a defined order.
 *
 * The identity returned is the JWT identity of the connection that sent
 * that awareness state — NOT `state.user.name`. Awareness is entirely
 * client-controlled; trusting its name let an anonymous editor write any
 * display name ("CEO Bob") into the activity log.
 */
export function mostRecentVerifiedEditor(
  identities: ReadonlyMap<number, VerifiedIdentity & { seq: number }> | undefined
): VerifiedIdentity | null {
  if (!identities) return null
  let latest: (VerifiedIdentity & { seq: number }) | null = null
  for (const identity of identities.values()) {
    if (!latest || identity.seq > latest.seq) latest = identity
  }
  if (!latest) return null
  return latest.avatarSeed
    ? { userId: latest.userId, userName: latest.userName, avatarSeed: latest.avatarSeed }
    : { userId: latest.userId, userName: latest.userName }
}

/**
 * Compute word count from a Y.Text's string content.
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0
  return text.trim().split(/\s+/).length
}

/**
 * Git-style line counts between two versions of a string.
 * Uses a Myers-ish LCS (straight DP, O(n*m) — fine for markdown docs under
 * a few thousand lines; we cap at a sane size to avoid pathological memory).
 *
 * Returns { added, removed } where:
 *   - `added` is the number of lines present in `after` but not in the matching
 *      LCS positions (i.e. newly inserted lines),
 *   - `removed` is the symmetric count for `before`.
 */
export function lineDiff(before: string, after: string): { added: number, removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  const a = before.split('\n')
  const b = after.split('\n')
  // Cap: if either side is absurdly long, fall back to an approximate count
  // (abs delta of line counts) — accuracy doesn't matter at scale and DP would
  // allocate hundreds of MB.
  if (a.length > 2000 || b.length > 2000) {
    const delta = b.length - a.length
    return delta > 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta }
  }
  // LCS table — dp[i][j] = LCS length of a[0..i) vs b[0..j).
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  const at = (i: number, j: number): number => dp[i]?.[j] ?? 0
  for (let i = 0; i < m; i++) {
    const row = dp[i + 1]
    if (!row) continue
    for (let j = 0; j < n; j++) {
      row[j + 1] = a[i] === b[j] ? at(i, j) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const common = at(m, n)
  return {
    added: n - common,
    removed: m - common
  }
}
