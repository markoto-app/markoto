import { describe, expect, it } from 'vitest'
import {
  classifyFailureSignals,
  errorCodeOf,
  type FailureExpectations,
  type ProviderOutage,
  type ServerErrorSignal
} from '../e2e/fixtures/failureSignals'

// The suite-wide flow failure check (tests/e2e/fixtures/flow.ts): a declared
// live-provider outage skips the flow, and ONLY that outage does.

const IMAGE_OUTAGE: ProviderOutage = {
  path: /^\/api\/docs\/[^/]+\/images\/generate$/,
  codes: ['ai/image-provider-unavailable'],
  toasts: [/image provider is not available/i],
  reason: 'the image provider (Black Forest Labs) is unavailable'
}

const withOutage: FailureExpectations = { toasts: [], serverErrors: [], outages: [IMAGE_OUTAGE] }
const none: FailureExpectations = { toasts: [], serverErrors: [], outages: [] }

function serverError(over: Partial<ServerErrorSignal> = {}): ServerErrorSignal {
  return {
    actor: 'primary',
    status: 502,
    method: 'POST',
    path: '/api/docs/abc123/images/generate',
    code: 'ai/image-provider-unavailable',
    ...over
  }
}

describe('classifyFailureSignals', () => {
  it('passes a flow without signals', () => {
    expect(classifyFailureSignals({ errorToasts: [], serverErrors: [] }, withOutage)).toEqual({ failures: [], outage: null })
  })

  it('reports a declared outage (502 / 503 / 504 with the code) as an outage, not a failure', () => {
    for (const status of [502, 503, 504]) {
      const verdict = classifyFailureSignals({ errorToasts: [], serverErrors: [serverError({ status }), serverError({ status })] }, withOutage)
      expect(verdict.failures).toEqual([])
      expect(verdict.outage).toBe(IMAGE_OUTAGE)
    }
  })

  it('fails the same 502 when the flow declared no outage', () => {
    const verdict = classifyFailureSignals({ errorToasts: [], serverErrors: [serverError()] }, none)
    expect(verdict.outage).toBeNull()
    expect(verdict.failures).toEqual(['server error [primary]: 502 on POST /api/docs/abc123/images/generate (ai/image-provider-unavailable)'])
  })

  it('fails a 500, another code, no code, or another route', () => {
    for (const e of [
      serverError({ status: 500 }),
      serverError({ code: 'ai/image-failed' }),
      serverError({ code: 'internal' }),
      serverError({ code: null }),
      serverError({ path: '/api/docs/abc123/pdf' })
    ]) {
      const verdict = classifyFailureSignals({ errorToasts: [], serverErrors: [e] }, withOutage)
      expect(verdict.failures, JSON.stringify(e)).toHaveLength(1)
      expect(verdict.outage).toBeNull()
    }
  })

  it('fails when an outage comes with any other failure signal', () => {
    const verdict = classifyFailureSignals({
      errorToasts: [],
      serverErrors: [serverError(), serverError({ status: 500, path: '/api/docs/abc123/meta', method: 'PUT', code: 'internal' })]
    }, withOutage)
    expect(verdict.failures).toEqual(['server error [primary]: 500 on PUT /api/docs/abc123/meta (internal)'])
    expect(verdict.outage).toBeNull()
  })

  it('tolerates the outage\'s own toast only alongside the outage', () => {
    const toast = { actor: 'primary', title: 'AI request failed', description: 'The image provider is not available right now. Try again later.' }
    expect(classifyFailureSignals({ errorToasts: [toast], serverErrors: [serverError()] }, withOutage))
      .toEqual({ failures: [], outage: IMAGE_OUTAGE })
    const alone = classifyFailureSignals({ errorToasts: [toast], serverErrors: [] }, withOutage)
    expect(alone.failures).toHaveLength(1)
    expect(alone.outage).toBeNull()
  })

  it('fails an unrelated error toast next to the outage', () => {
    const verdict = classifyFailureSignals({
      errorToasts: [{ actor: 'primary', title: 'Could not save', description: '' }],
      serverErrors: [serverError()]
    }, withOutage)
    expect(verdict.failures).toEqual(['error toast [primary]: "Could not save"'])
    expect(verdict.outage).toBeNull()
  })

  it('keeps expectServerError / expectErrorToast working', () => {
    const verdict = classifyFailureSignals({
      errorToasts: [{ actor: 'primary', title: 'Wrong password', description: '' }],
      serverErrors: [serverError({ status: 500, path: '/api/x', code: 'internal' })]
    }, { toasts: [/wrong password/i], serverErrors: [/^\/api\/x$/], outages: [] })
    expect(verdict).toEqual({ failures: [], outage: null })
  })
})

describe('errorCodeOf', () => {
  it('reads the code of an app error body', () => {
    expect(errorCodeOf({ statusCode: 502, data: { code: 'ai/image-provider-unavailable' } })).toBe('ai/image-provider-unavailable')
    expect(errorCodeOf({ code: 'x/y' })).toBe('x/y')
  })

  it('is null for anything else', () => {
    for (const body of [null, undefined, 'text', 42, {}, { data: null }, { data: { code: 7 } }]) {
      expect(errorCodeOf(body)).toBeNull()
    }
  })
})
