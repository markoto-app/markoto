import { setAiSuggestEdits } from '../../repos/users'
import { setAiSuggestBody } from '~~/shared/api/account'

// PUT /api/user/ai-suggest: {suggest}. With it on, the AI proposes its
// document edits as suggestions a person accepts or rejects, in the editor
// and in delegated jobs. Documents that require suggestions of the user
// turn it on regardless.
export default defineApiHandler({
  access: allow.user(),
  body: setAiSuggestBody,
  handler: async ({ self, body }) => {
    await setAiSuggestEdits(self, body.suggest)
    return { suggest: body.suggest }
  }
})
