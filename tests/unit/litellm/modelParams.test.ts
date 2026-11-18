import { describe, expect, it } from 'vitest'
import { modelRequestParams } from '../../../server/utils/litellm/modelParams'

describe('modelRequestParams', () => {
  it('Mistral Large 4: top_p 1 with greedy sampling and reasoning_effort low (never none)', () => {
    for (const model of ['mistral-large-4', 'mistral-large-4-0', 'mistral-large-latest', 'byok/mistral-large-latest', 'byok/mistral/mistral-large-4']) {
      expect(modelRequestParams(model, { temperature: 0, purpose: 'loop' })).toEqual({ temperature: 0, top_p: 1, reasoning_effort: 'low' })
    }
    expect(modelRequestParams('mistral-large-4', { temperature: 0.2, purpose: 'worker' })).toEqual({ temperature: 0.2, top_p: 1, reasoning_effort: 'low' })
  })

  it('Mistral Large 3 does not reason and gets the plain request', () => {
    expect(modelRequestParams('mistral-large-2512', { temperature: 0, purpose: 'loop' })).toEqual({ temperature: 0 })
  })

  it('GLM-5.3 Flash: only the temperature (reasoning_effort low is set on the LiteLLM deployment)', () => {
    for (const model of ['zai-glm-5-3-flash', 'markoto-worker', 'markoto-utility']) {
      expect(modelRequestParams(model, { temperature: 0, purpose: 'worker' })).toEqual({ temperature: 0 })
    }
  })

  it('DeepSeek V4.1 Flash: only the temperature (reasoning off on the deployment; `none` here would reach a GLM fallback)', () => {
    expect(modelRequestParams('deepseek-v4-1-flash-1017', { temperature: 0, purpose: 'loop' })).toEqual({ temperature: 0 })
  })

  it('unknown and BYOK models get only the temperature', () => {
    for (const model of ['byok/gpt-4o-mini', 'byok/llama3.1', 'markoto-worker-strong', 'mistral-small-2603']) {
      expect(modelRequestParams(model, { temperature: 0.3, purpose: 'subcall' })).toEqual({ temperature: 0.3 })
    }
  })
})
