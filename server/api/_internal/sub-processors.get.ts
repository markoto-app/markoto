import { visibleSubProcessors } from '../../legal/registryView'
import { isBillingEnabled } from '../../utils/billing/billingMode'
import { assertLegalSurfacesEnabled } from '../../utils/platform/instanceConfig'

// Public sub-processor registry (`server/legal/subProcessors.ts`) so the
// client-side `/legal/sub-processors` page needn't import server-only code.
// Public because GDPR Art. 13(1)(e) requires disclosing recipients.
//
// With billing off Stripe is never contacted, so it is omitted
// (`server/legal/registryView.ts`).

export default defineEventHandler(() => {
  assertLegalSurfacesEnabled()
  return visibleSubProcessors(isBillingEnabled())
})
