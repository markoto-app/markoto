import { describe, it, expect } from 'vitest'
import { resolveByteRange, withByteRange } from '../../../server/runtime/mediaRange'

// Byte ranges for the bundled videos (server/runtime/mediaRange.ts): Safari
// plays a <video> only from a server that honours Range.

describe('resolveByteRange', () => {
  it('reads first-last, open-ended and suffix ranges', () => {
    expect(resolveByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(resolveByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(resolveByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(resolveByteRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('refuses ranges outside the file, reversed, empty or multiple', () => {
    for (const header of ['bytes=1000-', 'bytes=5-2', 'bytes=-', 'bytes=-0', 'bytes=0-1,5-9', 'items=0-1']) {
      expect(resolveByteRange(header, 1000), header).toBeNull()
    }
  })
})

describe('withByteRange', () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)
  const full = () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4', 'ETag': '"x"' } })

  it('answers 206 with the requested bytes and keeps the other headers', async () => {
    const res = await withByteRange('GET', '/tour/light/write/video.av1.mp4', 'bytes=10-19', full())
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('etag')).toBe('"x"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('advertises ranges on a full video answer', async () => {
    const res = await withByteRange('GET', '/tour/a.mp4', null, full())
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('answers 416 for a range outside the file', async () => {
    const res = await withByteRange('GET', '/tour/a.mp4', 'bytes=500-', full())
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })

  it('leaves other files, other methods and failed answers alone', async () => {
    const page = new Response('x', { status: 200 })
    expect(await withByteRange('GET', '/docs', 'bytes=0-1', page)).toBe(page)
    const head = full()
    expect(await withByteRange('HEAD', '/tour/a.mp4', 'bytes=0-1', head)).toBe(head)
    const missing = new Response(null, { status: 404 })
    expect(await withByteRange('GET', '/tour/a.mp4', 'bytes=0-1', missing)).toBe(missing)
  })
})
