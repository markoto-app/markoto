// Posts activity events to the Nuxt app's internal endpoint.
// Fire-and-forget: failures are logged but never block Y.js sync.

import { injectTraceHeaders, captureException } from './sentry'
import { syncEnv } from './env'
import { useLogger } from './logger'
import type { InternalActivityEvent } from '../../shared/contracts/activity'

const log = useLogger('activity-logger')

const APP_URL = syncEnv().sync.appUrl
const INTERNAL_SECRET = syncEnv().auth.internalApiSecret

// The row shape is the activity contract shared with the app's
// POST /api/internal/activity.
export async function logActivity(event: InternalActivityEvent): Promise<void> {
  if (!APP_URL || !INTERNAL_SECRET) {
    // Silent no-op if not configured, dev setups without activity logging still work
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
    log.warn('failed to log activity', { action: event.action, docId: event.docId, err: e })
    // App-side activity loss is operationally interesting, a steady
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
    } catch { /* swallow, telemetry must never throw */ }
  }
}

/** Identity of the authenticated connection an awareness client id was
 *  last received on: taken from that connection's JWT, never from the
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
 * that awareness state: NOT `state.user.name`. Awareness is entirely
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
 * Uses a Myers-ish LCS (straight DP, O(n*m), fine for markdown docs under
 * a few thousand lines; we cap at a sane size to avoid pathological memory).
 *
 * Returns { added, removed } where:
 *   - `added` is the number of lines present in `after` but not in the matching
 *      LCS positions (i.e. newly inserted lines),
 *   - `removed` is the symmetric count for `before`.
 */
export function lineDiff(before: string, after: string): { added: number, removed: number } {
  return lineDiffDigests(lineDigest(before), lineDigest(after))
}

// Line digests: the diff baseline kept in Valkey per open document
// (`sync:prev-lines:`). Each line is reduced to a 48-bit hash, so a
// baseline costs 8 characters per line instead of the line itself, and a
// document above LINE_DIFF_MAX_LINES keeps only its line count (the diff
// of such documents is the line-count delta anyway). That bounds one
// document's baseline at about 16 KB whatever its size. A hash collision
// can make one changed line count as unchanged; the counts are a summary.

/** Above this many lines on either side, the diff is the line-count delta
 *  (an LCS table would allocate hundreds of MB). */
export const LINE_DIFF_MAX_LINES = 2000
const HASH_BYTES = 6
const HASH_CHARS = 8 // base64 of 6 bytes, no padding

/** cyrb53-style 64-bit string hash, as two 32-bit halves. */
function hashLine(line: string): [number, number] {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return [h1 >>> 0, h2 >>> 0]
}

/** `"<lines>:<base64 hashes>"`, or `"<lines>"` above LINE_DIFF_MAX_LINES. */
export function lineDigest(text: string): string {
  const lines = text.split('\n')
  if (lines.length > LINE_DIFF_MAX_LINES) return String(lines.length)
  const buf = Buffer.alloc(lines.length * HASH_BYTES)
  lines.forEach((line, i) => {
    const [h1, h2] = hashLine(line)
    buf.writeUInt32BE(h1, i * HASH_BYTES)
    buf.writeUInt16BE(h2 & 0xffff, i * HASH_BYTES + 4)
  })
  return `${lines.length}:${buf.toString('base64')}`
}

interface ParsedDigest {
  count: number
  hashes: string[] | null
}

function parseDigest(digest: string): ParsedDigest | null {
  const sep = digest.indexOf(':')
  const count = Number(sep === -1 ? digest : digest.slice(0, sep))
  if (!Number.isSafeInteger(count) || count < 1) return null
  if (sep === -1) return { count, hashes: null }
  const body = digest.slice(sep + 1)
  if (body.length !== count * HASH_CHARS) return null
  const hashes: string[] = []
  for (let i = 0; i < count; i++) hashes.push(body.slice(i * HASH_CHARS, (i + 1) * HASH_CHARS))
  return { count, hashes }
}

/**
 * Lines added / removed between two digests (`lineDigest`). Null when
 * either value is not a digest (a corrupted or foreign Valkey value).
 *
 * Returns { added, removed } where:
 *   - `added` is the number of lines present in `after` but not in the matching
 *      LCS positions (i.e. newly inserted lines),
 *   - `removed` is the symmetric count for `before`.
 */
export function lineDiffDigests(before: string, after: string): { added: number, removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  const a = parseDigest(before)
  const b = parseDigest(after)
  if (!a || !b) return { added: 0, removed: 0 }
  if (!a.hashes || !b.hashes) {
    const delta = b.count - a.count
    return delta > 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta }
  }
  const common = lcsLength(a.hashes, b.hashes)
  return { added: b.count - common, removed: a.count - common }
}

/** Length of the longest common subsequence (two rolling rows). */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  let curr = new Array<number>(b.length + 1).fill(0)
  for (const x of a) {
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = x === b[j] ? (prev[j] ?? 0) + 1 : Math.max(curr[j] ?? 0, prev[j + 1] ?? 0)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length] ?? 0
}
