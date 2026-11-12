// Typed reads of one comment (or reply) in a document's `comments` Y.Array.
// The entries are written by every client of the document, so a field can be
// missing or of the wrong type; each read here falls back instead of throwing,
// and callers pick their own display fallbacks (an absent author name is
// "Anonymous" in one place, "Unknown" in another).
//
// No `yjs` import: the sync server loads `shared/` with only `shared/`'s own
// dependencies, so the map is taken by its `get` alone (a `Y.Map` fits).
import { z } from 'zod'

/** The part of a `Y.Map` these readers use. */
export interface YMapLike {
  get(key: string): unknown
}

const yCommentFields = z.object({
  /** Missing on a corrupt entry; such an entry is skipped by most readers. */
  id: z.string().optional().catch(undefined),
  body: z.string().catch(''),
  /** Null for anonymous and AI authors. */
  authorId: z.number().nullable().catch(null),
  authorName: z.string().nullable().catch(null),
  /** Anonymous authors only: the random per-tab avatar token. */
  authorAvatarSeed: z.unknown(),
  /** Epoch milliseconds; 0 when missing. */
  createdAt: z.number().catch(0),
  updatedAt: z.number().catch(0),
  // Clients have only ever written booleans; read any truthy value as resolved.
  resolved: z.unknown().transform(v => Boolean(v)),
  /** Base64-encoded Y.RelativePosition of the anchor's start and end. */
  anchorStart: z.string().nullable().catch(null),
  anchorEnd: z.string().nullable().catch(null)
})

export type YCommentFields = z.output<typeof yCommentFields>

const KEYS = yCommentFields.keyof().options

/** Read a comment's fields; every field has a typed fallback. */
export function readYComment(map: YMapLike): YCommentFields {
  const raw: Record<string, unknown> = {}
  for (const key of KEYS) raw[key] = map.get(key) ?? null
  return yCommentFields.parse(raw)
}
