import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { loggedInClient, anonClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'

// Wire-path regression tests for the THREE 402 budget gates retired in
// Phase 6: /api/ai/prompt, /api/docs/.../trigger-ai, /api/ai/dictate/token.
//
// Pre-Phase-6 each of these endpoints checked `interactionsRemaining
// <= 0` and 402-rejected exhausted users before a session opened.
// Phase 6 retired the app-side counter — exhaustion is now enforced
// at the LiteLLM proxy on the first model call. The endpoints
// themselves NO LONGER 402: the session opens (200/202), the runLoop
// catches `LitellmBudgetExhausted` from the proxy and surfaces the
// upgrade-CTA breadcrumb.
//
// These tests pin the new behaviour at the wire layer:
//   1. Budget exhausted at the proxy via `/api/_test/exhaust-litellm-
//      budget` (which calls /key/update with max_budget=0).
//   2. Posting to each AI endpoint returns success (NOT 402).
//   3. The runLoop's downstream call to LiteLLM gets the
//      budget_exceeded response — but that's an async background
//      detail handled inside the loop, not a wire-level failure.
//
// We don't drive a full prompt round-trip here — that's flow-level
// territory. The contract under test is "the endpoint stops checking
// the app-side counter and no longer pre-rejects." If a future
// regression ever re-introduces a 402 before session open, every
// test in this file fails uniformly.

async function exhaustBudget(userId: number): Promise<void> {
  const res = await anonClient().post('/api/_test/exhaust-litellm-budget', { userId })
  if (res.status !== 200) {
    throw new Error(`exhaustBudget failed: ${res.status} ${await res.text()}`)
  }
}

describe('Budget-exhausted users still pass the session-open boundary', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('/api/ai/prompt accepts the request (NOT 402) when the user\'s LiteLLM budget is drained', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await exhaustBudget(u.id)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: 'doomed prompt — proxy will reject mid-loop'
    })
    // Pre-Phase-6 this returned 402 with `code: 'ai/budget-exhausted'`.
    // Post-Phase-6 the session opens — runLoop catches the proxy 400
    // asynchronously and emits the upgrade breadcrumb.
    expect(res.status).not.toBe(402)
    expect([200, 202]).toContain(res.status)
  })

  it('/api/ai/dictate/token mints a token (NOT 402) when budget is drained', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await exhaustBudget(u.id)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/dictate/token', { docId: doc.docId })
    expect(res.status).not.toBe(402)
    expect(res.status).toBe(200)
    const body = await res.json() as { token?: string }
    // Token is minted — the WS handshake will succeed; budget
    // enforcement happens on the first voice-tick post.
    expect(typeof body.token).toBe('string')
  })

  it('/api/docs/:docId/comments/:commentId/trigger-ai opens the session (NOT 402) when budget is drained', async () => {
    // Triggering AI from a comment thread requires (a) the doc to
    // exist, (b) a real comment row keyed on `docId` + `commentId`
    // already in the doc's Y.js state. We don't have a Y.js client
    // in scope here, so we bypass that part by aiming directly at a
    // synthetic commentId. The handler's first contentful step is
    // `requireDocViewAccess` + the budget pre-check that USED to
    // 402; both run before the comment is resolved out of Y.js.
    //
    // If the budget gate were still in place we'd see 402 even with
    // an unknown commentId because that gate ran first. Now we see
    // a 404 (or similar non-402) because the comment lookup fails
    // — proving the budget gate is gone.
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await exhaustBudget(u.id)

    const client = await loggedInClient(u.id)
    const res = await client.post(
      `/api/docs/${doc.docId}/comments/missing-comment-id/trigger-ai`,
      {}
    )
    // The post-Phase-6 wire path is "no 402 from the budget gate."
    // Concrete status depends on downstream resolution (404/500/etc.)
    // — we don't pin one because the failure mode varies across the
    // not-found path and isn't load-bearing for this test's contract.
    expect(res.status).not.toBe(402)
  })
})
