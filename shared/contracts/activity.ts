// The activity log's row vocabulary, shared by the sync server (which posts
// rows to POST /api/internal/activity), the app (which stores them in
// `activity_log` and serves them to the feed) and the client feed (which
// narrows the metadata by `kind` and, for AI tool rows, by `tool`).
import { z } from 'zod'

export const ACTIVITY_ACTIONS = [
  'edit', 'join', 'leave',
  'comment.added', 'comment.replied',
  'comment.resolved', 'comment.reopened', 'comment.deleted',
  'theme.changed', 'title.changed', 'ai.tool',
  'restore',
  'ai.job', 'ai.job.reverted'
] as const

export type ActivityAction = typeof ACTIVITY_ACTIONS[number]

const source = z.object({ title: z.string(), uri: z.string() })
const fetchedImage = z.object({ url: z.string(), description: z.string().optional() })

/** Metadata of an `ai.tool` row, one shape per tool the feed shows. */
export const aiToolActivityMetadata = z.discriminatedUnion('tool', [
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('web_search'), query: z.string(), sources: z.array(source).optional() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('fetch_url'), url: z.string(), summary: z.string().optional(), images: z.array(fetchedImage).optional() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('generate_image'), prompt: z.string() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('view_image'), src: z.string() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('search_knowledge'), query: z.string() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('get_knowledge_file'), knowledgeId: z.string() }),
  z.object({ kind: z.literal('ai.tool'), tool: z.literal('replace_all'), query: z.string(), replacement: z.string(), count: z.number() })
])

/**
 * The jsonb `metadata` of an activity row, keyed by `kind` (= the row's
 * action). The UI renders strings via i18n at read time, so rows stay
 * locale-agnostic. `comment.deleted` carries `isReply` because the comments
 * row is gone by the time the feed renders; `comment.replied` carries
 * `parentCommentId` for deep-linking. `restore` freezes the anchor row's time
 * so the "From {relative time}" label can't drift.
 */
export const activityMetadata = z.union([
  z.object({ kind: z.enum(['comment.added', 'comment.resolved', 'comment.reopened']), commentId: z.string(), bodyPreview: z.string() }),
  z.object({ kind: z.literal('comment.replied'), commentId: z.string(), parentCommentId: z.string(), bodyPreview: z.string() }),
  z.object({ kind: z.literal('comment.deleted'), commentId: z.string(), bodyPreview: z.string(), isReply: z.boolean() }),
  z.object({ kind: z.literal('title.changed'), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal('theme.changed') }),
  aiToolActivityMetadata,
  z.object({ kind: z.literal('restore'), restoredFromActivityId: z.number(), restoredFromTime: z.string() }),
  // A delegated AI edit (job) started or finished; counts only, never text.
  z.object({ kind: z.literal('ai.job'), jobId: z.string(), mode: z.string(), phase: z.enum(['started', 'finished']), status: z.string(), unitsTotal: z.number(), done: z.number(), skipped: z.number(), flagged: z.number() }),
  z.object({ kind: z.literal('ai.job.reverted'), jobId: z.string(), mode: z.string(), reverted: z.number(), followUps: z.number().optional(), skipped: z.number() })
])

export type ActivityMetadata = z.infer<typeof activityMetadata>
export type AiToolActivityMetadata = z.infer<typeof aiToolActivityMetadata>

/**
 * POST /api/internal/activity (sync server → app). Optional fields of the
 * wrong type are ignored, as the sender is another container of the stack and
 * one bad field must not drop the whole row; metadata of an unknown shape is
 * dropped for the same reason.
 */
export const internalActivityBody = z.object({
  docId: z.string().min(1),
  action: z.enum(ACTIVITY_ACTIONS),
  userId: z.number().nullish().catch(null),
  userName: z.string().nullish().catch(null),
  /**
   * Synthetic-principal label for agent-driven rows (`'ai:assistant:{sid}'`,
   * `'mcp:{sid}'`); null for human edits. See `activity_log.actor_principal`.
   */
  actorPrincipal: z.string().nullish().catch(null),
  /** Anonymous editors only: the per-tab avatar token their awareness broadcasts. */
  actorAvatarSeed: z.string().nullish().catch(null),
  wordCount: z.number().nullish().catch(null),
  linesAdded: z.number().nullish().catch(null),
  linesRemoved: z.number().nullish().catch(null),
  metadata: activityMetadata.nullish().catch(null),
  /** Boundary `yjs_updates.id` values around the store event (the diff endpoint replays both). */
  yjsDocIdBefore: z.number().nullish().catch(null),
  yjsDocIdAfter: z.number().nullish().catch(null)
})

/** What the sync server sends to POST /api/internal/activity. */
export type InternalActivityEvent = z.input<typeof internalActivityBody>
