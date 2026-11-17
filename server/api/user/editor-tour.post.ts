import { markEditorTourDone } from '../../repos/userPolicies'

// POST /api/user/editor-tour: the user finished or skipped the editor's
// first-run tour. Stored on the account so the tour shows once per user, on
// any browser and after sign-out (which clears localStorage). Read back as
// `editorTourDone` from /api/user/account-status.
export default defineApiHandler({
  access: allow.user(),
  body: 'none',
  handler: async ({ self }) => {
    await markEditorTourDone(self)
    return { done: true }
  }
})
