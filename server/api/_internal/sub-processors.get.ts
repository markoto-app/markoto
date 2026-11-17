import { visibleSubProcessors } from '../../legal/registryView'
import { currentRegistryFlags } from '../../utils/privacy/registryFlags'

// Public sub-processor registry (`server/legal/subProcessors.ts`) so the
// client-side `/legal/sub-processors` page needn't import server-only code.
// Public because GDPR Art. 13(1)(e) requires disclosing recipients.
//
// Recipients of switched-off features (Stripe with billing off, Google Ads
// without ad conversions) are omitted (`server/legal/registryView.ts`).

export default defineApiHandler({
  access: allow.public('GDPR Art. 13(1)(e) requires disclosing the recipients to anyone'),
  instance: 'legalSurfaces',
  handler: () => visibleSubProcessors(currentRegistryFlags())
})
