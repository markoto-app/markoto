import { listAiProviders } from '../../../repos/aiProviders'
import { toProviderView } from '../../../utils/aiProviders/store'
import { readInstanceDefault, resolveByokUrlPolicy } from '../../../utils/aiProviders/config'
import { availabilityFrom, resolveAiAccess } from '../../../utils/aiProviders/resolve'
import { resolvePayingPlan } from '../../../utils/billing/billing'
import { AI_CAPABILITIES, PROVIDER_PRESETS } from '~~/shared/ai/providers'

// GET /api/user/ai-providers: everything the "AI provider" settings
// page needs: the caller's saved configs (key-free views), which
// capabilities have an instance default, the effective availability,
// and the URL policy (so the UI can show the allowed providers and hide
// local presets the instance would refuse).

export default defineApiHandler({
  access: allow.user(),
  handler: async ({ user, self }) => {
    const [rows, access] = await Promise.all([
      listAiProviders(self),
      resolvePayingPlan(user.id, null).then(plan => resolveAiAccess(self, plan))
    ])
    const policy = resolveByokUrlPolicy()
    return {
      providers: rows.map(toProviderView),
      instanceDefaults: {
        chat: readInstanceDefault('chat') !== null,
        image: readInstanceDefault('image') !== null,
        transcription: readInstanceDefault('transcription') !== null
      },
      availability: availabilityFrom(access.providers, access),
      policy: {
        allowedBaseUrls: policy.allowedBaseUrls,
        allowPrivate: policy.allowPrivate
      },
      presets: PROVIDER_PRESETS.filter(p => (policy.allowPrivate || !p.local)
        && (policy.allowedBaseUrls.length === 0 || policy.allowedBaseUrls.some(u => p.baseUrl === u || p.baseUrl.startsWith(`${u}/`)))),
      capabilities: AI_CAPABILITIES
    }
  }
})
