import { planAccountDeletion } from '../../utils/privacy/accountDeletionPlan'
import { isBillingEnabled } from '../../utils/billing/billingMode'

// Pre-deletion preview — surface to the user EXACTLY what will happen
// when they confirm the deletion. Drives the consequence modal in
// `/settings/profile`. Read-only; no side effects.
//
// Two important UX constraints baked into the response:
//
// 1. **Workspace fates are spelled out.** For each workspace the user
//    is in, we explain whether it will be cascade-deleted (sole-member
//    case) or auto-promoted to a specific named member, OR (for
//    non-admin memberships) just removed. The UI uses this to render
//    "Engineering: Bob will become admin" and to call out the cascade
//    cases prominently with a link to "delete this workspace yourself
//    first if you want full control over what's removed".
//
// 2. **Owned-doc list is included** so the user can scan it before
//    confirming. We cap at 100 entries in the response — if the user
//    has more than 100 docs we show the count and the first 100. The
//    UI tells them "+ 42 more docs". This is informational only; the
//    sweeper still deletes all of them.

export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => {
    const plan = await planAccountDeletion(self)
    if (!plan) {
      throw apiError('internal')
    }

    return {
      userId: plan.userId,
      ownedDocs: {
        total: plan.ownedDocs.length,
        sample: plan.ownedDocs.slice(0, 100)
      },
      commentsToAnonymise: plan.commentsToAnonymise,
      workspaces: plan.workspaces,
      aiUsage: {
        sessions: plan.aiSessionsToDelete,
        sessionMessages: plan.aiSessionMessagesToDelete
      },
      dataExportJobs: plan.dataExportJobsToDelete.length,
      // Billing off → the Stripe step is skipped (no Stripe client on this
      // deployment), so don't promise it in the consequences modal.
      stripeCustomerWillBeDeleted: plan.stripeCustomerToDelete !== null && isBillingEnabled(),
      retainedAnonymised: plan.rowsRetainedAnonymised
    }
  }
})
