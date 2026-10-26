import { visibleSubProcessors } from '../../legal/registryView'
import { isBillingEnabled } from '../../utils/billingMode'
import { assertLegalSurfacesEnabled } from '../../utils/instanceConfig'

// Public-readable sub-processor registry. Surfaces the structured
// data from `server/legal/subProcessors.ts` so the client-side
// `/legal/sub-processors` page can render the table without
// importing server-only code.
//
// GDPR Article 13(1)(e) requires us to disclose recipients (or
// categories of recipients) of personal data. Anonymous + logged-in
// readers alike — and any regulator — should be able to fetch this.
//
// Deployment-aware: with billing off Stripe is never contacted, so it
// is omitted (see `server/legal/registryView.ts`). Otherwise the
// response is the registry shape unchanged.

export default defineEventHandler(() => {
  assertLegalSurfacesEnabled()
  return visibleSubProcessors(isBillingEnabled())
})
