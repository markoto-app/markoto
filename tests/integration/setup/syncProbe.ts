import { TEST_INTERNAL_SECRET, TEST_SYNC_URL } from './env'

// Test-side probe of the sync-test container's TEST_MODE-only `/internal/_test/recent-kicks` ring buffer. The
// real sync-server records every `/internal/kick-user` call alongside its real kick handler, so a failed
// dispatch shows up the same way it would in prod (a missing entry).
//
// The endpoint requires the same `X-Internal-Secret` as the rest of `/internal/*`; the test process knows it
// via TEST_INTERNAL_SECRET (which is also what the sync-test container is built with). Tests don't bypass the
// secret check, so this code path mirrors prod auth.

export interface RecordedKick {
  userId: string
  docIds: string[]
  at: number
}

export async function fetchRecentKicks(): Promise<RecordedKick[]> {
  const res = await fetch(`${TEST_SYNC_URL}/internal/_test/recent-kicks`, {
    headers: { 'X-Internal-Secret': TEST_INTERNAL_SECRET }
  })
  if (!res.ok) {
    throw new Error(`[sync-probe] recent-kicks fetch failed: HTTP ${res.status} ${await res.text()}`)
  }
  const body = await res.json() as { kicks?: RecordedKick[] }
  return body.kicks ?? []
}

export async function clearRecentKicks(): Promise<void> {
  const res = await fetch(`${TEST_SYNC_URL}/internal/_test/recent-kicks`, {
    method: 'DELETE',
    headers: { 'X-Internal-Secret': TEST_INTERNAL_SECRET }
  })
  if (!res.ok) {
    throw new Error(`[sync-probe] recent-kicks clear failed: HTTP ${res.status}`)
  }
}

/**
 * Poll the buffer until at least one kick matches the predicate, or
 * timeout. Kicks are dispatched fire-and-forget by the Nuxt app, the
 * mutation HTTP response returns BEFORE the kick lands at the sync
 * server, so synchronous checks would race.
 */
export async function waitForKick(
  predicate: (k: RecordedKick) => boolean,
  timeoutMs = 3000
): Promise<RecordedKick> {
  const start = Date.now()
  let last: RecordedKick[] = []
  while (Date.now() - start < timeoutMs) {
    last = await fetchRecentKicks()
    const hit = last.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`[sync-probe] no matching kick after ${timeoutMs}ms. Recorded: ${JSON.stringify(last)}`)
}
