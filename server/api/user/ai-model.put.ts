import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/database'

// PUT /api/user/ai-model — the platform chat model the user wants (WP5):
// {tier: 'fast' | 'strong'}. Stored either way; 'strong' is applied only
// while the paying plan includes `aiStrongModel` and the operator set
// NUXT_AI_DEFAULT_CHAT_STRONG_MODEL (server/utils/aiProviders/resolve.ts).
// The user's own chat key is never affected.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const body = await readBody<{ tier?: unknown }>(event)
  if (body?.tier !== 'fast' && body?.tier !== 'strong') {
    throw createError({ statusCode: 400, message: 'tier must be fast or strong' })
  }
  await useDatabase().update(users).set({ aiModelTier: body.tier }).where(eq(users.id, session.user.id))
  return { tier: body.tier }
})
