import { listOwnedByUser } from '../../repos/documents'

// "My Documents" for the dashboard. Returns docs the caller owns. Workspace
// docs they don't own stay inside the workspace view, keeps this list
// semantically "my stuff" vs. "everything I can edit".
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => {
    const docs = await listOwnedByUser(self)
    // Always true here; the dashboard UI relies on the field being present.
    return docs.map(d => ({ ...d, isOwner: true as const }))
  }
})
