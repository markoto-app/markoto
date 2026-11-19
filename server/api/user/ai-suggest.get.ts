import { getAiSuggestEdits } from '../../repos/users'

// GET /api/user/ai-suggest: whether the AI's edits arrive as suggestions by
// default (the prompt bar's switch starts from it).
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => ({ suggest: await getAiSuggestEdits(self) })
})
