import { generateImageBody } from '~~/shared/api/ai'
import { IMAGE_SIZES } from '~~/shared/ai/imageGeneration'
import { HOUR_MS } from '~~/shared/config/units'
import { resolveBillingContext } from '../../../../utils/billing/billing'
import { requireAiProviders } from '../../../../utils/aiProviders/guard'
import { assertFreeAllowanceAvailable, freeAllowanceExhaustedHttpError } from '../../../../utils/billing/freeAllowance'
import { budgetExhaustedMessageKey, limitRecovery } from '../../../../utils/billing/billingMode'
import { imageQuotaError } from '../../../../utils/storage/imageQuota'
import { generateDocumentImage, type DocumentImageFailure } from '../../../../utils/ai/tools/imageTools'
import { appendActivity, pruneActivity } from '../../../../repos/activity'
import { useLogger } from '../../../../utils/platform/logger'

const log = useLogger('ai-image')

/** Images a user can generate by hand per hour (each one is a paid generation). */
const MANUAL_IMAGES_PER_HOUR = 20

// POST /api/docs/:docId/images/generate: the editor's "Generate image
// with AI" dialog. Everything the AI can do a user can do by hand: this is
// the agent's and MCP's `generate_image` (`generateDocumentImage`), run for
// the signed-in editor. The same gates apply: the image provider of the
// plan that pays here (own key → instance default; 409
// `plan/feature-unavailable` when the plan lacks `aiImage`, 409
// `ai/provider-missing` without any), the shared free allowance (402), the
// AI Points budget (402 `ai/budget-exhausted`, enforced by LiteLLM), the
// image storage quota (409 `upload/storage-quota`) and a per-user hourly
// limit. The image is stored as an upload of the document; the response
// carries its Markdown, which the editor inserts at the cursor (so the
// edit itself is the user's). An `ai.tool` activity row names the user.
export default defineApiHandler({
  access: allow.doc('write-content'),
  body: generateImageBody,
  rateLimit: { namespace: 'ai-generate-image', max: MANUAL_IMAGES_PER_HOUR, windowMs: HOUR_MS, key: 'user', error: 'ai/image-rate-limited' },
  handler: async ({ user, self, docId, doc, docAccess, body }) => {
    const workspaceId = doc.workspaceId
    const billing = await resolveBillingContext(user.id, workspaceId)
    const providers = await requireAiProviders(self, 'image', billing.plan)
    await assertFreeAllowanceAvailable(providers.image, billing.plan)

    const { width, height } = IMAGE_SIZES[body.size]
    const result = await generateDocumentImage({
      docId,
      initiatorUserId: user.id,
      workspaceId,
      self,
      docAccess,
      aiProviders: providers,
      virtualKey: billing.virtualKey,
      updateStatus: () => {}
    }, { prompt: body.prompt, alt: body.prompt.slice(0, 200), width, height })
    if (!result.ok) throw failureError(result.failure)

    try {
      await appendActivity(docAccess, {
        userId: user.id,
        userName: user.name,
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'generate_image', prompt: body.prompt.slice(0, 300) }
      })
      await pruneActivity(docAccess)
    } catch (e) {
      log.warn('activity row for a generated image failed', { docId, err: e })
    }
    return { markdown: result.markdown, url: result.url }
  }
})

function failureError(failure: DocumentImageFailure) {
  switch (failure.kind) {
    case 'storage-quota':
      return imageQuotaError(failure.maxBytes)
    case 'upload':
      log.error('generated image upload failed', { message: failure.message })
      return apiError('ai/image-failed')
    case 'generation': {
      const { budget, providerUnavailable, error } = failure.failure
      if (budget === 'free-allowance') return freeAllowanceExhaustedHttpError()
      if (budget === 'personal') return apiError('ai/budget-exhausted', { messageKey: budgetExhaustedMessageKey(), recovery: limitRecovery() })
      if (providerUnavailable) return apiError('ai/image-provider-unavailable')
      log.warn('image generation failed', { message: error })
      return apiError('ai/image-failed')
    }
  }
}
