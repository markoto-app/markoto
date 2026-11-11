// Request schemas of the workspace routes (server/api/workspaces/**: core,
// members, invites, knowledge, usage). Shared with the client, which may
// validate a form with the same schema before sending.
import { z } from 'zod'
import { serialId } from './ids'
import { DocThemeSchema } from '../types/theme'

const wsId = z.string().min(1)

/** A trimmed, non-empty name of at most 255 characters. */
const workspaceName = z.string().trim().min(1).max(255)

/** A description of at most 1024 characters; blank after trimming means "none" (null). */
const workspaceDescription = z.string().trim().max(1024).transform(s => (s === '' ? null : s))

/** POST /api/workspaces. */
export const createWorkspaceBody = z.object({
  name: workspaceName,
  description: workspaceDescription.nullish()
})

/** PUT /api/workspaces/:wsId. A field left out keeps its value; an empty body changes nothing. */
export const updateWorkspaceBody = z.object({
  name: workspaceName.optional(),
  description: workspaceDescription.nullable().optional(),
  /** `null` clears the default (back to the markoto preset). */
  defaultTheme: DocThemeSchema.nullable().optional()
}).nullish()

/** `:inviteId` is a nanoid-style token (`parseInviteId`). */
export const workspaceInviteParams = z.object({
  wsId,
  inviteId: z.string().regex(/^[\w-]{8,32}$/)
})

export const workspaceMemberParams = z.object({
  wsId,
  userId: serialId
})

/** PATCH /api/workspaces/:wsId/members/:userId. Guests are changed by sharing, not here. */
export const updateMemberRoleBody = z.object({
  role: z.enum(['admin', 'editor', 'viewer'])
})

/** POST /api/workspaces/:wsId/members. The address shape is checked by the handler (`workspace/invalid-email`). */
export const inviteMemberBody = z.object({
  // Judged by the handler (`workspace/invalid-email`, before the invite rate limits): missing or not text too.
  email: z.string().nullish().catch(undefined),
  role: z.enum(['admin', 'editor', 'viewer', 'guest']).optional(),
  /** Buy one more seat first (Team / Business, the invite dialog's confirmation). */
  addSeat: z.boolean().optional()
})

export const workspaceKnowledgeParams = z.object({
  wsId,
  knowledgeId: z.string().min(1)
})

/** POST /api/workspaces/:wsId/knowledge/upload-request. */
export const requestKnowledgeUploadBody = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().positive()
})

/** POST /api/workspaces/:wsId/knowledge/confirm: what upload-request answered, echoed back. */
export const confirmKnowledgeUploadBody = z.object({
  knowledgeId: z.string().min(1),
  s3Key: z.string().min(1),
  filename: z.string().trim().min(1),
  ext: z.string().min(1).transform(s => s.toLowerCase()),
  mimeType: z.string().min(1)
})
