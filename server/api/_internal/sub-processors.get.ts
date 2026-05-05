import { SUB_PROCESSORS } from '../../legal/subProcessors'

// Public-readable sub-processor registry. Surfaces the structured
// data from `server/legal/subProcessors.ts` so the client-side
// `/legal/sub-processors` page can render the table without
// importing server-only code.
//
// GDPR Article 13(1)(e) requires us to disclose recipients (or
// categories of recipients) of personal data. Anonymous + logged-in
// readers alike — and any regulator — should be able to fetch this.
//
// The response is a copy of the registry (no transforms): we
// return the same shape `SUB_PROCESSORS` exports so the page can
// render without re-mapping fields.

export default defineEventHandler(() => {
  return SUB_PROCESSORS
})
