import { aiPromptBody } from '~~/shared/api/ai'
import { startEditorPrompt } from '../../utils/agentic/sessions/editorPrompt'
import { sessionSuggestMode } from '../../utils/agentic/sessions/suggestMode'

// POST /api/ai/prompt: start an AI session on a document from the prompt
// bar (`utils/agentic/sessions/editorPrompt.ts`). The text loop always runs
// through LiteLLM (the secret validator enforces its URL and master key at
// boot); its per-user-key rpm_limit is the only rate limit. The session
// runs in the background: the response returns the session id once it is
// registered, and the edits reach the client over Y.js.
export default defineApiHandler({
  access: allow.doc('write-content', { docId: { from: 'body' } }),
  body: aiPromptBody,
  handler: async ({ event, user, doc, docAccess, self, body }) => startEditorPrompt(event, {
    docAccess,
    self,
    user: { id: user.id, name: user.name },
    prompt: body.prompt,
    editorSelection: body.editorSelection,
    suggest: await sessionSuggestMode(doc, self, body.suggest)
  })
})
