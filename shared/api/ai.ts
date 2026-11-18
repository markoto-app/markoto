// Request schemas of the AI, comment-thread and image-upload routes
// (server/api/ai/**, server/api/docs/[docId]/comments/**, server/api/upload/**).
import { z } from 'zod'
import { ID_RE } from '../config/identifiers'
import { IMAGE_PROMPT_MAX_LENGTH, IMAGE_SIZE_NAMES } from '../ai/imageGeneration'

/** Longest accepted comment / reply id (ids are minted client-side in the Y.Array). */
const COMMENT_ID_MAX = 64

/** Document ids as minted by `POST /api/docs`: 8-32 URL-safe characters. */
const UPLOAD_DOC_ID_RE = /^[A-Za-z0-9_-]{8,32}$/

const commentId = z.string().min(1).max(COMMENT_ID_MAX)

/** A query value that is only advisory: anything but a short string counts as absent. */
const advisoryWorkspaceId = z.string().max(64).optional().catch(undefined)

/** POST /api/ai/abort */
export const abortAiSessionBody = z.object({ sessionId: z.string().min(1) })

/** GET /api/ai/availability */
export const aiAvailabilityQuery = z.object({ workspaceId: advisoryWorkspaceId })

/** GET /api/ai/credits. Any workspace id is accepted; membership is checked by the handler. */
export const aiCreditsQuery = z.object({ workspaceId: z.string().optional().catch(undefined) })

/** POST /api/docs/:docId/images/generate (the editor's "Generate image with AI"). */
export const generateImageBody = z.object({
  prompt: z.string().trim().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
  size: z.enum(IMAGE_SIZE_NAMES)
})

/** POST /api/ai/dictate/token */
export const dictateTokenBody = z.object({ docId: z.string().min(1) })

/** POST /api/ai/prompt. `editorSelection` is validated by the prompt builder, which degrades a bad snapshot. */
export const aiPromptBody = z.object({
  docId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  editorSelection: z.unknown().optional()
})

/** `:sessionId` of /api/ai/sessions/:sessionId/**. */
export const aiSessionParams = z.object({ sessionId: z.string().regex(ID_RE) })

/** Longest note the initiator may send with a Deny ("No, search for X instead"). */
export const CONFIRM_NOTE_MAX_LENGTH = 300

/** POST /api/ai/sessions/:sessionId/confirm. `note` is read only with `allow: false`. */
export const confirmAiSessionBody = z.object({
  confirmationId: z.string().regex(ID_RE),
  allow: z.boolean(),
  note: z.string().trim().max(CONFIRM_NOTE_MAX_LENGTH).optional()
})

/** POST /api/ai/transcribe. The audio rules (type, size) answer with their own codes in the handler. */
export const transcribeBody = z.object({
  audio: z.string().optional(),
  mimeType: z.string().optional(),
  languageCode: z.string().optional(),
  workspaceId: advisoryWorkspaceId
})

/** DELETE /api/docs/:docId/comments/:commentId */
export const commentParams = z.object({ docId: z.string().min(1), commentId })

/** DELETE /api/docs/:docId/comments/:commentId/replies/:replyId */
export const replyParams = commentParams.extend({ replyId: z.string().min(1).max(COMMENT_ID_MAX) })

/** POST /api/docs/:docId/comments/:commentId/trigger-ai */
export const triggerCommentAiBody = z.object({
  replyId: z.string().min(1).max(COMMENT_ID_MAX).nullish()
}).nullish()

/** POST /api/upload/request */
export const requestUploadBody = z.object({
  docId: z.string().regex(UPLOAD_DOC_ID_RE),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  // Signed into the PUT and reserved against the quota: a positive integer.
  size: z.number().int().positive()
})

/** POST /api/upload/confirm */
export const confirmUploadBody = z.object({ key: z.string().min(1) })

/** Ids of delegated AI jobs (`j-` + nanoid). */
const AI_JOB_ID_RE = /^j-[A-Za-z0-9_-]{6,40}$/

/** `:docId/:jobId` of /api/docs/:docId/ai-jobs/:jobId/**. */
export const aiJobParams = z.object({ docId: z.string().min(1), jobId: z.string().regex(AI_JOB_ID_RE) })

/** POST /api/docs/:docId/ai-jobs/:jobId/{cancel,resume,revert}: no fields. */
export const aiJobActionBody = z.object({}).nullish()
