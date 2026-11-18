import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { WORKER_PRICES, workerPrice } from '../../../server/utils/litellm/workerPrices'

// The cost estimate before a delegated job reads the worker prices from
// code; the proxy charges what deploy/config/litellm/config.yaml says.
// They must agree.

const CONFIG_PATH = fileURLToPath(new URL('../../../deploy/config/litellm/config.yaml', import.meta.url))

const deployment = z.object({
  model_name: z.string(),
  litellm_params: z.object({ model: z.string(), api_base: z.string().optional(), allowed_openai_params: z.array(z.string()).optional(), reasoning_effort: z.string().optional() }).passthrough(),
  model_info: z.object({
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional()
  }).passthrough().optional()
})
const config = z.object({
  model_list: z.array(deployment),
  router_settings: z.object({ fallbacks: z.array(z.record(z.string(), z.array(z.string()))), max_fallbacks: z.number().optional() }).passthrough()
}).passthrough().parse(parse(readFileSync(CONFIG_PATH, 'utf8')))

function entry(alias: string) {
  const found = config.model_list.find(d => d.model_name === alias)
  if (!found) throw new Error(`${alias} is not a deployment in config.yaml`)
  return found
}

describe('worker prices', () => {
  it.each(Object.keys(WORKER_PRICES))('%s matches its deployment in config.yaml', (alias) => {
    const info = entry(alias).model_info ?? {}
    const price = workerPrice(alias)
    expect(price).not.toBeNull()
    expect(price?.input).toBe(info.input_cost_per_token)
    expect(price?.output).toBe(info.output_cost_per_token)
    expect(price?.cachedInput).toBe(info.cache_read_input_token_cost ?? info.input_cost_per_token)
  })

  it('the worker aliases run on Mistral\'s EU endpoint and let prompt_cache_key through', () => {
    expect(entry('markoto-worker').litellm_params.model).toBe('mistral/zai-glm-5-3-flash')
    expect(entry('markoto-utility').litellm_params.model).toBe('mistral/zai-glm-5-3-flash')
    expect(entry('markoto-worker-strong').litellm_params.model).toBe('mistral/deepseek-v4-1-flash-1017')
    for (const alias of Object.keys(WORKER_PRICES)) {
      expect(entry(alias).litellm_params.api_base, alias).toBe('https://api.eu.mistral.ai/v1')
      expect(entry(alias).litellm_params.allowed_openai_params, alias).toContain('prompt_cache_key')
    }
  })

  it('the worker and utility aliases cost the same as the hosted chat default (GLM-5.3 Flash), the strong worker as DeepSeek V4.1 Flash', () => {
    const glm = entry('zai-glm-5-3-flash').model_info
    for (const alias of ['markoto-worker', 'markoto-utility']) {
      expect(entry(alias).model_info, alias).toMatchObject({
        input_cost_per_token: glm?.input_cost_per_token,
        output_cost_per_token: glm?.output_cost_per_token,
        cache_read_input_token_cost: glm?.cache_read_input_token_cost
      })
    }
    const deepseek = entry('deepseek-v4-1-flash-1017').model_info
    expect(entry('markoto-worker-strong').model_info).toMatchObject({
      input_cost_per_token: deepseek?.input_cost_per_token,
      output_cost_per_token: deepseek?.output_cost_per_token,
      cache_read_input_token_cost: deepseek?.cache_read_input_token_cost
    })
  })

  it('GLM workers think as little as Mistral allows (reasoning_effort low; `none` is a 400 for zai-glm-5-3)', () => {
    for (const alias of ['markoto-worker', 'markoto-utility']) {
      expect(entry(alias).litellm_params.reasoning_effort, alias).toBe('low')
    }
  })

  it('DeepSeek has reasoning off, Large 4 the request shape it needs', () => {
    for (const alias of ['deepseek-v4-1-flash-1017', 'markoto-worker-strong']) {
      expect(entry(alias).litellm_params.reasoning_effort, alias).toBe('none')
    }
    expect(entry('mistral-large-4').litellm_params).toMatchObject({ model: 'mistral/mistral-large-4-0', reasoning_effort: 'low', top_p: 1 })
  })

  it('the new Mistral-served deployments bill the EU price (1.1x list)', () => {
    expect(entry('deepseek-v4-1-flash-1017').model_info).toMatchObject({ input_cost_per_token: 0.00000033, cache_read_input_token_cost: 0.0000000077, output_cost_per_token: 0.00000132 })
    expect(entry('mistral-large-4').model_info).toMatchObject({ input_cost_per_token: 0.00000077, cache_read_input_token_cost: 0.000000077, output_cost_per_token: 0.00000231 })
    for (const alias of ['deepseek-v4-1-flash-1017', 'mistral-large-4']) {
      expect(entry(alias).litellm_params.api_base, alias).toBe('https://api.eu.mistral.ai/v1')
      expect(entry(alias).litellm_params.allowed_openai_params, alias).toContain('prompt_cache_key')
    }
  })

  it('fallbacks go to DeepSeek V4.1 Flash, never to Mistral Small 4 (100k tokens/minute)', () => {
    const fallbacks = Object.assign({}, ...config.router_settings.fallbacks) as Record<string, string[]>
    for (const alias of ['zai-glm-5-3-flash', 'markoto-worker', 'markoto-utility']) {
      expect(fallbacks[alias], alias).toEqual(['deepseek-v4-1-flash-1017'])
    }
    expect(fallbacks['markoto-worker-strong']).toEqual(['zai-glm-5-3-flash'])
    expect(fallbacks['deepseek-v4-1-flash-1017']).toEqual(['zai-glm-5-3-flash'])
    expect(fallbacks['mistral-large-4']).toEqual(['deepseek-v4-1-flash-1017'])
    const smallAsFallback = Object.entries(fallbacks).filter(([from, targets]) => from !== 'mistral-small-2603' && targets.includes('mistral-small-2603'))
    expect(smallAsFallback).toEqual([])
    const smallAsAlias = config.model_list.filter(d => d.model_name.startsWith('markoto-') && d.litellm_params.model === 'mistral/mistral-small-2603')
    expect(smallAsAlias).toEqual([])
  })

  it('one hop only: DeepSeek and GLM both sit behind two names, so a second hop would retry the model that just failed', () => {
    expect(config.router_settings.max_fallbacks).toBe(1)
  })

  it('every fallback target is a deployment', () => {
    const names = new Set(config.model_list.map(d => d.model_name))
    for (const rule of config.router_settings.fallbacks) {
      for (const [from, targets] of Object.entries(rule)) {
        expect(names.has(from), from).toBe(true)
        for (const t of targets) expect(names.has(t), t).toBe(true)
      }
    }
  })

  it('knows no price for other models (BYOK, operator endpoints, prototype keys)', () => {
    expect(workerPrice('gpt-5.4-mini')).toBeNull()
    expect(workerPrice('constructor')).toBeNull()
  })
})
