import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMAGE_SIZES, PRICED_IMAGE_MODELS, platformImagePriceUsd } from '../../../shared/ai/imageGeneration'

// The sizes the "Generate image with AI" dialog offers and the price it
// shows before generating.

const LITELLM_CONFIG = readFileSync(fileURLToPath(new URL('../../../deploy/config/litellm/config.yaml', import.meta.url)), 'utf8')

describe('image sizes', () => {
  it('stay inside the generate_image bounds and at or below one megapixel', () => {
    for (const [name, { width, height }] of Object.entries(IMAGE_SIZES)) {
      for (const side of [width, height]) {
        expect(side, name).toBeGreaterThanOrEqual(512)
        expect(side, name).toBeLessThanOrEqual(1536)
        expect(side % 32, name).toBe(0)
      }
      expect(width * height, name).toBeLessThanOrEqual(1024 * 1024)
    }
  })
})

describe('platformImagePriceUsd', () => {
  it('prices the bundled FLUX alias by size tier', () => {
    expect(platformImagePriceUsd('flux-3-image-klein', 1024, 1024)).toBeCloseTo(0.009, 6)
    expect(platformImagePriceUsd('flux-3-image-klein', 1344, 768)).toBeCloseTo(0.009, 6)
    expect(platformImagePriceUsd('flux-3-image-klein', 1536, 1536)).toBeCloseTo(0.014, 6)
  })

  it('knows no price for an alias it does not list', () => {
    expect(platformImagePriceUsd('someone-elses-model', 1024, 1024)).toBeNull()
    expect(platformImagePriceUsd('constructor', 1024, 1024)).toBeNull()
  })

  it('every priced alias is a deployment of the bundled LiteLLM config', () => {
    for (const model of PRICED_IMAGE_MODELS) {
      expect(LITELLM_CONFIG, model).toContain(`model_name: ${model}`)
    }
  })
})
