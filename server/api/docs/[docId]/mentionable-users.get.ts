import { getDoc } from '../../../repos/documents'
import { listMembers } from '../../../repos/workspaceMembers'

// Typeahead source for `@`-mentions inside doc comments.
//
// Privacy posture (AGENTS.md §4 "no user enumeration"): only workspace
// docs return a real list — and only to members of that workspace.
// Standalone (anonymous-created) docs and non-member viewers get an
// empty list — the comment composer falls back to plain `@text` with no
// autocomplete.
//
// Returns minimal fields needed to render the typeahead row + emit the
// `@[Name](user:N)` token: { id, name, email, avatarUrl }.

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const doc = await getDoc(docId)
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })

  // No workspace = no enumeration. Comments still work, just without
  // autocomplete on a non-existent member roster.
  if (!doc.workspaceId) return { users: [] }

  // The viewer must be a workspace member to enumerate the roster. Doc
  // owners who have been booted from the workspace lose this privilege —
  // they can still see comments via the doc-level grant, but typing `@`
  // gets them no list. Mirrors `members.get.ts`'s posture.
  const role = await getWorkspaceRole(userId, doc.workspaceId)
  if (role === null) return { users: [] }

  const members = await listMembers(doc.workspaceId)
  return {
    users: members.map(m => ({
      id: m.userId,
      name: m.name,
      email: m.email,
      avatarUrl: m.avatarUrl
    }))
  }
})
