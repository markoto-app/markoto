import { describe, it, expect } from 'vitest'
import { AI_RATE_LIMITED_MESSAGE, AI_UNAVAILABLE_MESSAGE, loopErrorMessage } from '../../../server/utils/agentic/loopErrorMessage'
import { AiProviderCallError, PROVIDER_ERROR_MESSAGES } from '../../../server/utils/aiProviders/requestFields'
import { AiProviderUrlRefused } from '../../../server/utils/aiProviders/urlPolicy'

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

describe('loopErrorMessage', () => {
  it('never shows LiteLLM router text for a platform model failure', () => {
    const e = statusError(400, 'litellm.BadRequestError: You passed in model=zai-glm-5-3-flash. There are no healthy deployments for this model')
    const msg = loopErrorMessage(e)
    expect(msg).toBe(AI_UNAVAILABLE_MESSAGE)
    expect(msg).not.toMatch(/litellm|zai|deployment/i)
  })

  it('maps a 429 to the rate-limit sentence', () => {
    expect(loopErrorMessage(statusError(429, 'litellm.RateLimitError: rpm limit for key sk-…'))).toBe(AI_RATE_LIMITED_MESSAGE)
  })

  it('falls back to the generic sentence for non-Error throws', () => {
    expect(loopErrorMessage('boom')).toBe(AI_UNAVAILABLE_MESSAGE)
    expect(loopErrorMessage(undefined)).toBe(AI_UNAVAILABLE_MESSAGE)
  })

  it('uses the fixed per-code sentence for BYOK errors, even when the error carries upstream text', () => {
    const e = new AiProviderCallError('auth-failed', 'upstream says: {"error":"bad key [REDACTED]", "internal":"http://10.0.0.5"}', 401)
    expect(loopErrorMessage(e)).toBe(PROVIDER_ERROR_MESSAGES['auth-failed'])
  })

  it('keeps our own URL-policy sentence', () => {
    const e = new AiProviderUrlRefused('invalid', 'This provider URL is not allowed on this instance.')
    expect(loopErrorMessage(e)).toBe(e.message)
  })
})
