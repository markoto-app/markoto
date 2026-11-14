import { describe, it, expect } from 'vitest'
import { mediaAssetHeaders } from '../../../server/utils/rendering/mediaAssetHeaders'
import { DEMO_VIDEO } from '../../../shared/media/demoVideo'

// Cache headers of the bundled media under /media/ (the demo video the
// /demo page plays): content-hashed names are immutable, anything else
// revalidates, other paths are untouched.

describe('mediaAssetHeaders', () => {
  it('caches the demo video, its poster and captions for a year', () => {
    for (const path of [DEMO_VIDEO.src, DEMO_VIDEO.poster, DEMO_VIDEO.captions]) {
      expect(mediaAssetHeaders(path)).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' })
    }
  })

  it('ignores the query string', () => {
    expect(mediaAssetHeaders(`${DEMO_VIDEO.src}?t=3`)?.['Cache-Control']).toContain('immutable')
  })

  it('revalidates a name without a content hash', () => {
    expect(mediaAssetHeaders('/media/markoto-demo.mp4')).toEqual({ 'Cache-Control': 'no-cache' })
    expect(mediaAssetHeaders('/media/sub/markoto-demo-0123456789.mp4')).toEqual({ 'Cache-Control': 'no-cache' })
  })

  it('leaves other paths alone', () => {
    expect(mediaAssetHeaders('/tour/light/write/video.h264.mp4')).toBeNull()
    expect(mediaAssetHeaders('/mediafoo/x-0123456789.mp4')).toBeNull()
  })

  it('names files the generated manifest points at', () => {
    expect(DEMO_VIDEO.src).toMatch(/^\/media\/markoto-demo-[0-9a-f]{10}\.mp4$/)
    expect(DEMO_VIDEO.poster).toMatch(/^\/media\/markoto-demo-poster-[0-9a-f]{10}\.webp$/)
    expect(DEMO_VIDEO.captions).toMatch(/^\/media\/markoto-demo-captions-[0-9a-f]{10}\.vtt$/)
  })
})
