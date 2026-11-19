import { describe, it, expect } from 'vitest'
import { buildCallUsageRecord, sumCallUsage, CALL_USAGE_EVENT } from '../../../server/utils/agentic/loop/callUsage'

// One machine-readable record per model call (eval harnesses parse the
// `ai.call.usage` log line). Pure: no Nitro, no logger.

describe('buildCallUsageRecord', () => {
  it('maps the stream usage and timings into the record', () => {
    const r = buildCallUsageRecord({
      sessionId: 's1',
      docId: 'd1',
      turn: 3,
      requestedModel: 'zai-glm-5-3-flash',
      providerModel: 'glm-5.3-flash',
      usage: { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 80, thoughtsTokenCount: 5 },
      startedAt: 1_000,
      firstChunkAt: 1_250,
      endedAt: 2_400,
      finishReason: 'STOP',
      retry: true
    })
    expect(r).toEqual({
      sessionId: 's1',
      docId: 'd1',
      turn: 3,
      phase: 'turn',
      requestedModel: 'zai-glm-5-3-flash',
      providerModel: 'glm-5.3-flash',
      promptTokens: 1200,
      cachedTokens: 1000,
      outputTokens: 80,
      reasoningTokens: 5,
      latencyMs: 1400,
      firstTokenMs: 250,
      finishReason: 'STOP',
      retry: true
    })
    expect(CALL_USAGE_EVENT).toBe('ai.call.usage')
  })

  it('defaults missing values to zero / null', () => {
    const r = buildCallUsageRecord({ sessionId: 's', turn: 1, requestedModel: 'm', startedAt: 5, endedAt: 4, phase: 'closing' })
    expect(r).toMatchObject({ docId: null, providerModel: null, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, firstTokenMs: null, finishReason: null, retry: false, phase: 'closing' })
    expect(r).not.toHaveProperty('tools')
  })

  it('names the tools the call asked for, so a session can be read from the log', () => {
    const r = buildCallUsageRecord({ sessionId: 's', turn: 4, requestedModel: 'm', startedAt: 0, endedAt: 1, tools: ['read_section', 'read_section'] })
    expect(r.tools).toEqual(['read_section', 'read_section'])
    expect(buildCallUsageRecord({ sessionId: 's', turn: 4, requestedModel: 'm', startedAt: 0, endedAt: 1, tools: [] })).not.toHaveProperty('tools')
  })
})

describe('sumCallUsage', () => {
  it('sums every counter, the calls, retries and latency', () => {
    const a = buildCallUsageRecord({ sessionId: 's', turn: 1, requestedModel: 'm', usage: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 2 }, startedAt: 0, endedAt: 100 })
    const b = buildCallUsageRecord({ sessionId: 's', turn: 1, requestedModel: 'm', usage: { promptTokenCount: 20, thoughtsTokenCount: 3 }, startedAt: 0, endedAt: 50, retry: true })
    expect(sumCallUsage([a, b])).toEqual({ calls: 2, retries: 1, promptTokens: 30, cachedTokens: 4, outputTokens: 2, reasoningTokens: 3, latencyMs: 150 })
    expect(sumCallUsage([])).toEqual({ calls: 0, retries: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0 })
  })
})
