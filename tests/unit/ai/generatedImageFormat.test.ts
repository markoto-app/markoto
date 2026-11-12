import { describe, expect, it } from 'vitest'
import { generatedImageFromFetch } from '../../../server/utils/ai/tools/imageGeneration'

// A provider that answers image generation with a URL: the fetched image is
// stored under an extension derived from its type, so only the formats the
// upload path names (PNG / JPEG / WebP) may pass. GIF and HEIC are fine for
// `view_image` but used to become `<id>.undefined` uploads here.

describe('generatedImageFromFetch', () => {
  const bytes = new Uint8Array([1, 2, 3])

  it('keeps a PNG / JPEG / WebP image', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(generatedImageFromFetch({ bytes, mimeType })).toEqual({ bytes, mimeType })
    }
  })

  it('refuses a GIF or HEIC answer instead of storing it without an extension', () => {
    for (const mimeType of ['image/gif', 'image/heic', 'image/heif']) {
      expect(generatedImageFromFetch({ bytes, mimeType })).toEqual({ error: expect.stringContaining('unsupported image format') })
    }
  })

  it('passes a fetch error through', () => {
    expect(generatedImageFromFetch({ error: 'blocked' })).toEqual({ error: 'blocked' })
  })
})
