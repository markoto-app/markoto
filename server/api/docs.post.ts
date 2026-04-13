import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { documents, users } from '../db/schema'

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const db = useDatabase()
  const docId = nanoid(10)

  // Sealed session cookies survive DB wipes, so a logged-in user's client may
  // carry a `user.id` that no longer exists in the users table. Validate before
  // using the id — otherwise the FK constraint on ownerId would 500 this endpoint
  // and the client would silently fall back to an orphaned random docId.
  let ownerId: number | null = null
  const sessionUserId = session?.user?.id as number | undefined
  if (typeof sessionUserId === 'number') {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.id, sessionUserId)).get()
    if (exists) {
      ownerId = sessionUserId
    } else {
      // Session references a deleted user — clear the cookie so subsequent requests
      // aren't silently anonymous-with-stale-metadata.
      await clearUserSession(event)
    }
  }

  db.insert(documents).values({ docId, ownerId }).run()

  return { docId }
})
