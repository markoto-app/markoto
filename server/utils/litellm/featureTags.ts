// Multi-dimensional spend tagging for LiteLLM. Every billable call
// site stamps `metadata.tags = [...]` on its request; the proxy
// persists the tags in `LiteLLM_SpendLogs.metadata` and exposes
// per-tag aggregation via /spend/tags. Multiple tags on a single
// request are independently aggregatable, the same call can show
// up under "feature:text-loop" AND "workspace:abc123" AND
// "user:42" simultaneously.
//
// Four axes:
//   - feature:*: what kind of call (transcribe, text-loop, etc.).
//                    Closed set; new features add a new entry here
//                    AND in the dashboard's TAG_LABELS map.
//   - workspace:*: which workspace context the call originated
//                    from. Open set (one tag per workspace_id). Used
//                    for per-workspace spend breakdowns and
//                    workspace-owner self-serve cost views.
//   - user:*: which user initiated the call. Open set (one
//                    per user_id). Lets a workspace owner identify
//                    which member is driving spend; also redundant
//                    with the virtual-key-bound `user_id` field but
//                    keeps everything queryable through the same
//                    /spend/tags endpoint without a second axis.
//   - doc:*: which document the call attaches to. Open set.
//                    Lets us answer "which doc burned the most AI
//                    Points this week" without joining LiteLLM's
//                    spend logs against our DB by user×workspace.
//                    Skipped for doc-less calls (voice-prompt
//                    transcribe, embeddings retrieval).
//
// Why a closed set of feature-tag constants and not free-form strings:
// tag drift (`transcribe-voice` vs `voice-transcribe` vs `transcribe`)
// silently fragments the dashboard's totals. The constants below are
// the only feature strings that show up in production spend metadata.

export const FEATURE_TAGS = {
  transcribe: 'feature:transcribe',
  textLoop: 'feature:text-loop',
  dictateTick: 'feature:dictate-tick',
  imageGen: 'feature:image-gen',
  embeddings: 'feature:embeddings',
  // "Create a design from a document" (vision model, theme panel)
  designImport: 'feature:design-import'
} as const

export type FeatureTag = typeof FEATURE_TAGS[keyof typeof FEATURE_TAGS]

/** Prefix discriminators for the dashboard's "other" bucket logic. */
export const TAG_NAMESPACES = ['feature:', 'workspace:', 'user:', 'doc:'] as const

/** All known feature tag values, used by the admin dashboard so unknown
 *  feature tags surface as "other" rather than silently disappearing. */
export const ALL_FEATURE_TAGS: FeatureTag[] = Object.values(FEATURE_TAGS)

/**
 * Build the workspace-axis tag for a given workspace id. Open-set,
 * any workspace id is valid. Returned as a plain string so it can be
 * pushed straight onto a `tags: [...]` array.
 */
export function workspaceTag(workspaceId: string): `workspace:${string}` {
  return `workspace:${workspaceId}`
}

/**
 * Build the user-axis tag for a given user id. Mirrors `workspaceTag`.
 * Distinct from the virtual-key-bound `user_id` field on /key/generate
 * that's used by /spend/users; THIS surfaces through /spend/tags so
 * the same axis system covers both queries.
 */
export function userTag(userId: number): `user:${number}` {
  return `user:${userId}`
}

/**
 * Build the doc-axis tag. Mirrors `workspaceTag` / `userTag`. Skipped
 * by `featureMetadata` when the caller has no doc context (e.g.
 * voice-prompt transcribe, knowledge-base ingest).
 */
export function docTag(docId: string): `doc:${string}` {
  return `doc:${docId}`
}

interface SpendContext {
  /** Workspace this call belongs to (if any). Null/undefined skips the workspace tag. */
  workspaceId?: string | null
  /** User who initiated this call (if known). Null/undefined skips the user tag. */
  userId?: number | null
  /** Document the call attaches to (if any). Null/undefined skips the doc tag. */
  docId?: string | null
}

/**
 * Build the LiteLLM `metadata` object for a given call. Always carries
 * the feature tag; conditionally carries workspace + user tags when
 * the caller has that context. Stamp the return value into the OpenAI
 * SDK request body: LiteLLM reads `metadata.tags` and forwards it
 * to its spend tracker.
 *
 * The OpenAI SDK's typed body doesn't include the `metadata.tags` extension.
 * Use the typed wrappers in `./createCompletion.ts` (`litellmCompletion`
 * for one-shot, `litellmStream` for streaming), they accept the
 * `metadata: { tags: string[] }` shape directly without spread casts.
 *
 * Example:
 *
 *   import { litellmCompletion } from './createCompletion'
 *   const resp = await litellmCompletion(litellm, {
 *     model: 'mistral-small-latest',
 *     messages: [...],
 *     ...featureMetadata(FEATURE_TAGS.textLoop, {
 *       workspaceId: session.workspaceId,
 *       userId: session.initiatorUserId
 *     })
 *   })
 */
export function featureMetadata(
  feature: FeatureTag,
  ctx: SpendContext = {}
): { metadata: { tags: string[] } } {
  const tags: string[] = [feature]
  if (ctx.workspaceId) tags.push(workspaceTag(ctx.workspaceId))
  if (typeof ctx.userId === 'number' && ctx.userId > 0) tags.push(userTag(ctx.userId))
  if (ctx.docId) tags.push(docTag(ctx.docId))
  return { metadata: { tags } }
}
