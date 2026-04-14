import { nanoid } from 'nanoid'
import { documents } from '../db/schema'

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  // Anonymous creation is allowed — ownerId falls back to null.
  const session = await getValidatedUserSession(event)
  const db = useDatabase()
  const docId = nanoid(10)
  const ownerId = session?.user?.id ?? null

  // Default visibility:
  //   - Logged-in owner → `private`. The user has to explicitly publish via
  //     the Share modal before anyone else can access it.
  //   - Anonymous creator → `open-edit`. There's no stable identity to tie
  //     "private" to, so defaulting to private would lock the creator out.
  const accessMode = ownerId != null ? 'private' : 'open-edit'

  await db.insert(documents).values({
    docId,
    ownerId,
    accessMode
  })

  return { docId }
})
