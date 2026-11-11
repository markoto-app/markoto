// Test-only endpoint that drives `executeFunctionByName` through the
// FULL server stack — auth middleware, repo/sync access via real
// Postgres + Hocuspocus — without the agentic loop or LLM upstream.
//
// Mirrors the design of `_test/login.post.ts`: 404 in any environment
// where TEST_MODE !== '1', so an accidentally-set env var on a prod
// box still doesn't expose the surface (the guard runs before any
// body parsing).
//
// Body: `{ docId, name, args }` — names a tool to invoke against a
// session anchored on the given docId. The endpoint:
//   1. Authenticates via the regular session cookie (the integration
//      tests use loggedInClient() which seeds it via /_test/login).
//   2. Re-validates that the doc exists. (The handler itself does
//      access checks; we only need the doc row to seed AiSession.)
//   3. Opens a transient Hocuspocus connection so the handler reads
//      live ytext, exactly as it would inside a real /api/ai/prompt
//      session — no fake Y.Doc.
//   4. Runs the named tool, returns `{ isError, content }` so tests
//      can assert on the structured shape.
//
// Anything that requires the real agentic loop (multi-turn tool
// chains, Mistral orchestration, streaming status) lives in a
// dedicated harness — out of scope here.

import * as Y from 'yjs'
import { executeFunctionByName } from '../../utils/ai/aiToolAdapter'
import { getDoc } from '../../repos/documents'
import { resolveAiProviders } from '../../utils/aiProviders/resolve'
import { resolveBillingContext } from '../../utils/billing/billing'
import type { DocToolContext, ToolStatusPhase } from '../../utils/agentic/toolContext'
import { isTestModeEnabled } from '../../../shared/utils/testMode'

export default defineEventHandler(async (event) => {
  if (!isTestModeEnabled()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const session = await requireValidatedUserSession(event)

  const body = await readBody<{
    docId?: unknown
    name?: unknown
    args?: unknown
  }>(event)

  const docId = typeof body?.docId === 'string' ? body.docId : null
  const name = typeof body?.name === 'string' ? body.name : null
  const args = (body?.args && typeof body.args === 'object') ? body.args : {}
  if (!docId) throw createError({ statusCode: 400, message: 'docId required' })
  if (!name) throw createError({ statusCode: 400, message: 'name required' })

  const doc = await getDoc(docId)
  if (!doc) throw createError({ statusCode: 404, message: 'Anchor doc not found' })

  // Detached Y.Doc for the anchor — integration tests don't bring up
  // a sync server (it's gated behind `--profile flows`). Cross-doc
  // tools open their OWN trusted client for the TARGET doc, which
  // does need sync; tests for the success path of view_other_document
  // are gated on sync availability and skipped when it's missing.
  // The session's ydoc/ymeta is only read by tools that mutate the
  // CURRENT doc (set_title, update_theme), which aren't exercised by
  // these tests.
  // The caller's virtual key via the normal billing resolver. Under
  // LITELLM_TEST_STUB=1 a user without a key gets the stub token (tools
  // that never reach the proxy don't care); a test that provisioned a
  // real key for its user (BYOK image generation through litellm-test)
  // gets that one, exactly like a real session would.
  const billing = await resolveBillingContext(session.user.id, doc.workspaceId)
  const virtualKey = billing.virtualKey

  const ydoc = new Y.Doc()
  const aiSession: DocToolContext = {
    ydoc,
    ytext: ydoc.getText('content'),
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    sessionId: `test-session-${Date.now()}`,
    docId,
    initiatorUserId: session.user.id,
    workspaceId: doc.workspaceId,
    attributedTo: `user:${session.user.id}`,
    plan: 'free',
    periodStart: new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1, 0, 0, 0
    )),
    virtualKey,
    // Real resolution so BYOK tests can drive e.g. generate_image with
    // the caller's configured image provider.
    aiProviders: await resolveAiProviders(session.user.id, billing.plan),
    updateStatus: (_phase: ToolStatusPhase, _message?: string) => { /* swallow */ }
  }

  const result = await executeFunctionByName(aiSession, name, args)
  // Surface extraParts when present (view_image, view_pages — anything
  // that smuggles inlineData bytes back to the model). Tests assert on
  // the part shape + base64; we don't decode here.
  return {
    isError: result.isError,
    content: result.content,
    extraParts: result.extraParts ?? null
  }
})
