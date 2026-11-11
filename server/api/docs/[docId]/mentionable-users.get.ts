import { listMembers } from '../../../repos/workspaceMembers'

// Typeahead source for `@`-mentions inside doc comments.
//
// Privacy posture (no user enumeration): only workspace
// docs return a real list — and only to members of that workspace.
// Standalone (anonymous-created) docs and non-member viewers get an
// empty list — the comment composer falls back to plain `@text` with no
// autocomplete.
//
// Returns minimal fields needed to render the typeahead row + emit the
// `@[Name](user:N)` token: { id, name, email }. The avatar is generated
// client-side from the id.
export default defineApiHandler({
  access: allow.doc('lookup', { reason: 'Never refuses an existing document: only members of its workspace (not guests) get a non-empty list.' }),
  handler: async ({ user, doc }) => {
    // No workspace = no enumeration. Comments still work, just without
    // autocomplete on a non-existent member roster.
    if (!doc.workspaceId) return { users: [] }

    // The viewer must be a workspace MEMBER to enumerate the roster
    // (`getWorkspaceRole` excludes guests, whose role on the doc row comes
    // from their share). Doc owners who have been booted from the workspace
    // lose this privilege — they can still see comments via the doc-level
    // grant, but typing `@` gets them no list.
    const role = await getWorkspaceRole(user.id, doc.workspaceId)
    if (role === null) return { users: [] }

    // Guests see only documents shared with them: not offered.
    const members = (await listMembers(doc.workspaceId)).filter(m => m.role !== 'guest')
    return {
      users: members.map(m => ({
        id: m.userId,
        name: m.name,
        email: m.email
      }))
    }
  }
})
