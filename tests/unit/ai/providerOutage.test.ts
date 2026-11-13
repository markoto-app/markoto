import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import { isProviderUnavailableError } from '../../../server/utils/ai/tools/providerOutage'
import { IMAGE_PROVIDER_UNAVAILABLE_MESSAGE } from '../../../shared/utils/aiProviderOutage'

// "Provider down" (5xx, connection error, timeout) vs every other failure:
// only the former may end a session as unavailable and skip a release flow.

describe('isProviderUnavailableError', () => {
  it('recognises the BFL 503 as LiteLLM reports it', () => {
    const e = new Error('500 litellm.APIConnectionError: Bfl-fluxException - Server error \'503 Service Temporarily Unavailable\' for url \'https://api.eu2.bfl.ai/v1/flux-2-pro\'')
    expect(isProviderUnavailableError(e)).toBe(true)
  })

  it('recognises gateway statuses and connection / timeout errors', () => {
    expect(isProviderUnavailableError(new APIError(503, undefined, 'unavailable', undefined))).toBe(true)
    expect(isProviderUnavailableError(new APIError(504, undefined, 'timeout', undefined))).toBe(true)
    expect(isProviderUnavailableError(new APIConnectionError({ message: 'Connection error.' }))).toBe(true)
    expect(isProviderUnavailableError(new APIConnectionTimeoutError({ message: 'Request timed out.' }))).toBe(true)
    expect(isProviderUnavailableError(new Error('connect ECONNREFUSED 10.0.0.1:4000'))).toBe(true)
  })

  it('does not treat client errors, budget, moderation or our own failures as an outage', () => {
    expect(isProviderUnavailableError(new APIError(400, undefined, 'bad request', undefined))).toBe(false)
    expect(isProviderUnavailableError(new APIError(401, undefined, 'invalid key', undefined))).toBe(false)
    expect(isProviderUnavailableError(new APIError(429, undefined, 'rate limited', undefined))).toBe(false)
    expect(isProviderUnavailableError(new Error('Budget has been exceeded! Current cost: 0.5'))).toBe(false)
    expect(isProviderUnavailableError(new Error('BFL returned no image bytes (content-moderated).'))).toBe(false)
    expect(isProviderUnavailableError(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isProviderUnavailableError('something odd')).toBe(false)
    expect(isProviderUnavailableError(null)).toBe(false)
  })
})

describe('IMAGE_PROVIDER_UNAVAILABLE_MESSAGE', () => {
  it('is the English text of ai/image-provider-unavailable', () => {
    const en = JSON.parse(readFileSync(join(__dirname, '../../../i18n/locales/errors/en.json'), 'utf8'))
    expect(en.apiErrors.ai['image-provider-unavailable']).toBe(IMAGE_PROVIDER_UNAVAILABLE_MESSAGE)
  })
})
