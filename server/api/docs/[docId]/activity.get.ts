import { eq, desc } from 'drizzle-orm'
import { activityLog } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const { docId } = getRouterParams(event)
  const db = useDatabase()

  const entries = db.select()
    .from(activityLog)
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(50)
    .all()

  return entries
})
