import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { setAiModelBody } from '~~/shared/api/account'

// PUT /api/user/ai-model — the platform chat model the user wants:
// {tier: 'fast' | 'strong'}. Stored either way; 'strong' is applied only
// while the paying plan includes `aiStrongModel` and the operator set
// NUXT_AI_DEFAULT_CHAT_STRONG_MODEL (server/utils/aiProviders/resolve.ts).
// The user's own chat key is never affected.
export default defineApiHandler({
  access: allow.user(),
  body: setAiModelBody,
  handler: async ({ user, body }) => {
    await useDatabase().update(users).set({ aiModelTier: body.tier }).where(eq(users.id, user.id))
    return { tier: body.tier }
  }
})
