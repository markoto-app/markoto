import { setAiModelTier } from '../../repos/users'
import { setAiModelBody } from '~~/shared/api/account'

// PUT /api/user/ai-model: the platform chat model the user wants:
// {tier: 'fast' | 'strong'}. Stored either way; 'strong' is applied only
// while the paying plan includes `aiStrongModel` and the operator set
// NUXT_AI_DEFAULT_CHAT_STRONG_MODEL (server/utils/aiProviders/resolve.ts).
// The user's own chat key is never affected.
export default defineApiHandler({
  access: allow.user(),
  body: setAiModelBody,
  handler: async ({ self, body }) => {
    await setAiModelTier(self, body.tier)
    return { tier: body.tier }
  }
})
