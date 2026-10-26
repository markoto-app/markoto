import { instanceDefaultProblems } from '../utils/aiProviders/config'

// Boot-time sanity check for the operator's AI instance defaults
// (`NUXT_AI_DEFAULT_*`). A half-configured default (base URL without a
// key, key without a model) is IGNORED at request time — users just see
// "Add your API key" — so warn loudly once at boot instead of failing
// silently. Never prints key material (only variable names).
export default defineNitroPlugin(() => {
  for (const problem of instanceDefaultProblems()) {
    console.warn(`[ai-providers] ${problem}`)
  }
})
