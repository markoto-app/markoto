// The display name the AI writes into the comment thread (`authorName`
// on comments and replies it creates, with `authorId: null`). ONE
// constant so the loop guard that stops the AI answering its own
// comments, the delete-permission check and the comment writer can't
// drift apart again — they did once: the writer switched to 'markoto'
// while the guard still compared against the old name.
export const AI_COMMENT_AUTHOR_NAME = 'markoto'

// Names older AI comments still carry in existing documents.
export const LEGACY_AI_COMMENT_AUTHOR_NAMES: readonly string[] = ['AI Assistant']

/**
 * True when a comment / reply was written by the AI (no user id + one
 * of the AI author names). Comment fields are client-writable Y.js
 * data, so this is a loop guard and a permission hint, never proof of
 * authorship.
 */
export function isAiCommentAuthor(authorId: unknown, authorName: unknown): boolean {
  if (authorId !== null && authorId !== undefined) return false
  if (typeof authorName !== 'string') return false
  return authorName === AI_COMMENT_AUTHOR_NAME || LEGACY_AI_COMMENT_AUTHOR_NAMES.includes(authorName)
}
