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
  router_settings: z.object({ fallbacks: z.array(z.record(z.string(), z.array(z.string()))) }).passthrough()
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
    expect(entry('markoto-worker-strong').litellm_params.model).toBe('mistral/mistral-small-2603')
    for (const alias of Object.keys(WORKER_PRICES)) {
      expect(entry(alias).litellm_params.api_base, alias).toBe('https://api.eu.mistral.ai/v1')
      expect(entry(alias).litellm_params.allowed_openai_params, alias).toContain('prompt_cache_key')
    }
  })

  it('the worker and utility aliases cost the same as the hosted chat default (GLM-5.3 Flash), the strong worker as Small 4', () => {
    const glm = entry('zai-glm-5-3-flash').model_info
    for (const alias of ['markoto-worker', 'markoto-utility']) {
      expect(entry(alias).model_info, alias).toMatchObject({
        input_cost_per_token: glm?.input_cost_per_token,
        output_cost_per_token: glm?.output_cost_per_token,
        cache_read_input_token_cost: glm?.cache_read_input_token_cost
      })
    }
    expect(entry('markoto-worker-strong').model_info).toMatchObject({
      input_cost_per_token: entry('mistral-small-2603').model_info?.input_cost_per_token,
      output_cost_per_token: entry('mistral-small-2603').model_info?.output_cost_per_token,
      cache_read_input_token_cost: entry('mistral-small-2603').model_info?.cache_read_input_token_cost
    })
  })

  it('GLM workers think as little as Mistral allows (reasoning_effort low; `none` is a 400 for zai-glm-5-3)', () => {
    for (const alias of ['markoto-worker', 'markoto-utility']) {
      expect(entry(alias).litellm_params.reasoning_effort, alias).toBe('low')
    }
  })

  it('the GLM workers fall back to Ministral 3 8B, never to a dearer model', () => {
    const fallbacks = Object.assign({}, ...config.router_settings.fallbacks) as Record<string, string[]>
    expect(fallbacks['markoto-worker']).toEqual(['ministral-8b-2512'])
    expect(fallbacks['markoto-utility']).toEqual(['ministral-8b-2512'])
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
