// Test-only: drives `executeFunctionByName` through the full server stack
// (auth middleware, real Postgres + Hocuspocus) without the agentic loop or an
// LLM upstream.
//
// Like `_test/login.post.ts`, 404s unless TEST_MODE === '1'; the guard runs
// before any body parsing so a stray env var on a prod box exposes nothing.
//
// Body: `{ docId, name, args }`. Authenticates via the session cookie,
// re-validates the doc exists (the tool handler does the access checks), opens
// a transient Hocuspocus connection so the tool reads live ytext, runs the
// tool and returns `{ isError, content }`.

import * as Y from 'yjs'
import { executeFunctionByName } from '../../utils/ai/tools/registry'
import { getDoc } from '../../repos/documents'
import { system } from '../../repos/proofs'
import { proveWorkspaceAccess } from '../../utils/access/workspaceAccess'
import { resolveAiProviders } from '../../utils/aiProviders/resolve'
import { resolveBillingContext } from '../../utils/billing/billing'
import type { DocToolContext, ToolStatusPhase } from '../../utils/agentic/toolContext'
import { testExecAiToolBody } from '~~/shared/api/platform'

export default defineApiHandler({
  access: allow.testOnly({ session: 'required' }),
  body: testExecAiToolBody,
  handler: async ({ user, self, body: input }) => {
    // The policy requires a session; the check narrows the type.
    if (!user) throw apiError('auth/required')
    const { docId, name } = input
    const args = (input.args && typeof input.args === 'object') ? input.args : {}

    // Test mode only: the harness acts on the anchor document without an
    // access decision of its own (the tools under test make theirs).
    const docAccess = system('test-harness').doc(docId)
    const doc = await getDoc(docAccess)
    if (!doc) throw apiError('docs/not-found')

    // Detached Y.Doc for the anchor: integration tests don't bring up a sync
    // server (gated behind `--profile flows`). Cross-doc tools open their own
    // client for the TARGET doc, which does need sync.
    // The session's ydoc/ymeta is only read by tools that mutate the
    // CURRENT doc (set_title, update_theme), which aren't exercised by
    // these tests.
    // The caller's virtual key via the normal billing resolver. Under
    // LITELLM_TEST_STUB=1 a user without a key gets the stub token (tools
    // that never reach the proxy don't care); a test that provisioned a
    // real key for its user (BYOK image generation through litellm-test)
    // gets that one, exactly like a real session would.
    const billing = await resolveBillingContext(user.id, doc.workspaceId)
    const virtualKey = billing.virtualKey

    const ydoc = new Y.Doc()
    const aiSession: DocToolContext = {
      ydoc,
      ytext: ydoc.getText('content'),
      ymeta: ydoc.getMap('meta'),
      awareness: null as never,
      sessionId: `test-session-${Date.now()}`,
      docId,
      initiatorUserId: user.id,
      workspaceId: doc.workspaceId,
      docAccess,
      self: self ?? system('test-harness').actingFor(user.id),
      workspaceAccess: doc.workspaceId ? await proveWorkspaceAccess(user.id, doc.workspaceId, 'member') : null,
      attributedTo: `user:${user.id}`,
      plan: 'free',
      periodStart: new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        1, 0, 0, 0
      )),
      virtualKey,
      // Real resolution so BYOK tests can drive e.g. generate_image with
      // the caller's configured image provider.
      aiProviders: await resolveAiProviders(user.id, billing.plan),
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
  }
})
