// Shared by the comments panel, thread and composer so the typeahead
// source has one shape end to end.

export interface MentionableUser {
  id: number
  name: string
  email: string | null
}

// Discriminated union shipped to CommentComposer. The AI entry is a
// synthetic row injected by CommentsPanel (not by the API) so the AI shows
// in the typeahead even on standalone docs without workspace members; the
// composer picks the token shape at insertion (`@ai` literal vs
// `@[Name](user:N)`).
export type MentionableEntry
  = | ({ kind: 'user' } & MentionableUser)
    | { kind: 'ai', id: 'ai', name: string, email: null, description: string, aliases?: readonly string[] }
