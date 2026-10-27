import { sql } from 'drizzle-orm'
import { useDatabase } from '../utils/database'

// Provenance queries for the AI taint gate (`server/utils/agentic/crossBoundary.ts`):
// "has anybody other than this user changed this document's content?"
//
// Content-changing activity rows are `edit`, `title.changed`,
// `theme.changed` and `restore`. A row counts as the user's own when it
// is attributed to them directly (`user_id`) or through one of the
// synthetic principals that act on their behalf:
//
//   ai:assistant:<sid>   their AI session (live `ai_sessions` row, or a
//                        conversation-memory row of theirs for that sid —
//                        `ai_sessions` rows are deleted at session end)
//   mcp:<sid>            their MCP client (`mcp_sessions.user_id`)
//   restore:<uid>:<sid>  a restore they ran
//   seed:<uid>           the body they seeded through create_document
//
// Everything else — another user, an anonymous editor of an open-edit
// doc, an AI / MCP session that can't be attributed — is foreign. The
// check is deliberately conservative: when in doubt the document counts
// as shared and cross-document tools ask before they run.

const CONTENT_ACTIONS = ['edit', 'title.changed', 'theme.changed', 'restore'] as const

/** True when `docId` has a content-changing activity row not attributable to `userId`. */
export async function hasForeignContentActivity(docId: string, userId: number): Promise<boolean> {
  const db = useDatabase()
  const actions = sql.join(CONTENT_ACTIONS.map(a => sql`${a}`), sql`, `)
  const uid = String(userId)
  const result = await db.execute(sql`
    SELECT 1 AS found
    FROM activity_log a
    WHERE a.doc_id = ${docId}
      AND a.action IN (${actions})
      AND NOT (
        a.user_id = ${userId}
        OR (
          a.actor_principal LIKE 'ai:assistant:%'
          AND (
            EXISTS (
              SELECT 1 FROM ai_sessions s
              WHERE s.session_id = substring(a.actor_principal FROM 14)
                AND s.initiator_user_id = ${userId}
            )
            OR EXISTS (
              SELECT 1 FROM ai_session_messages m
              WHERE m.session_id = substring(a.actor_principal FROM 14)
                AND m.user_id = ${userId}
            )
          )
        )
        OR (
          a.actor_principal LIKE 'mcp:%'
          AND EXISTS (
            SELECT 1 FROM mcp_sessions ms
            WHERE ms.mcp_session_id = substring(a.actor_principal FROM 5)
              AND ms.user_id = ${userId}
          )
        )
        OR a.actor_principal LIKE ${`restore:${uid}:%`}
        OR a.actor_principal = ${`seed:${uid}`}
      )
    LIMIT 1
  `)
  return result.rows.length > 0
}

/** Number of OTHER workspace members who can edit documents (admin / editor). */
export async function countOtherWorkspaceEditors(workspaceId: string, userId: number): Promise<number> {
  const db = useDatabase()
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM workspace_members
    WHERE workspace_id = ${workspaceId}
      AND user_id <> ${userId}
      AND role IN ('admin', 'editor')
  `)
  const n = result.rows[0]?.n
  return typeof n === 'number' ? n : Number(n ?? 0)
}
