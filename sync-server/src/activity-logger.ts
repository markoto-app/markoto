// Posts activity events to the Nuxt app's internal endpoint.
// Fire-and-forget — failures are logged but never block Y.js sync.

const APP_URL = process.env.APP_URL
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

type ActivityEvent = {
  docId: string
  userName: string | null
  action: 'edit' | 'join' | 'leave'
  wordCount?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
}

export async function logActivity(event: ActivityEvent): Promise<void> {
  if (!APP_URL || !INTERNAL_SECRET) {
    // Silent no-op if not configured — dev setups without activity logging still work
    return
  }

  try {
    await fetch(`${APP_URL}/api/internal/activity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    })
  } catch (e: any) {
    console.warn(`[activity-logger] Failed to log ${event.action} for ${event.docId}:`, e.message)
  }
}

/**
 * Pick the user whose awareness state was updated most recently.
 * Rationale: y-codemirror.next updates awareness on every cursor move / keystroke,
 * so `meta.lastUpdated` is a strong signal for "who just edited this".
 * This is far more accurate than picking the first user in the map.
 */
export function mostRecentEditorFromAwareness(awareness: any, fallback?: string | null): string | null {
  if (!awareness?.getStates || !awareness.meta) return fallback ?? null

  const states: Map<number, any> = awareness.getStates()
  const meta: Map<number, { clock: number, lastUpdated: number }> = awareness.meta

  let latestTime = 0
  let latestName: string | null = null

  for (const [clientID, state] of states) {
    const m = meta.get(clientID)
    const name = state?.user?.name
    if (!m || typeof name !== 'string') continue
    if (m.lastUpdated > latestTime) {
      latestTime = m.lastUpdated
      latestName = name
    }
  }

  return latestName ?? fallback ?? null
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
export function lineDiff(before: string, after: string): { added: number; removed: number } {
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
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      dp[i + 1][j + 1] = a[i] === b[j] ? dp[i][j] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const common = dp[m][n]
  return {
    added: n - common,
    removed: m - common
  }
}
