import { nanoid } from 'nanoid'
import { documents } from '../db/schema'

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const db = useDatabase()
  const docId = nanoid(10)

  db.insert(documents).values({
    docId,
    ownerId: session?.user?.id ?? null
  }).run()

  return { docId }
})
