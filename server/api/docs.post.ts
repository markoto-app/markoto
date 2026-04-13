import { nanoid } from 'nanoid'
import { documents } from '../db/schema'

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  // Anonymous creation is allowed — ownerId falls back to null.
  const session = await getValidatedUserSession(event)
  const db = useDatabase()
  const docId = nanoid(10)

  db.insert(documents).values({
    docId,
    ownerId: session?.user?.id ?? null
  }).run()

  return { docId }
})
