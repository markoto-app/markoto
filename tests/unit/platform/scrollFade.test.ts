import { describe, expect, it } from 'vitest'
import { scrollFadeEdges } from '../../../app/utils/platform/scrollFade'

describe('scrollFadeEdges', () => {
  it('fades nothing when everything fits', () => {
    expect(scrollFadeEdges(0, 300, 300)).toEqual({ start: false, end: false })
    expect(scrollFadeEdges(0, 300.6, 300)).toEqual({ start: false, end: false })
  })

  it('fades the end while more follows', () => {
    expect(scrollFadeEdges(0, 600, 300)).toEqual({ start: false, end: true })
  })

  it('fades both edges in the middle', () => {
    expect(scrollFadeEdges(120, 600, 300)).toEqual({ start: true, end: true })
  })

  it('fades only the start at the far end', () => {
    expect(scrollFadeEdges(300, 600, 300)).toEqual({ start: true, end: false })
    expect(scrollFadeEdges(299.5, 600, 300)).toEqual({ start: true, end: false })
  })

  it('reads a right-to-left strip (negative scroll offsets) the same way', () => {
    expect(scrollFadeEdges(-120, 600, 300)).toEqual({ start: true, end: true })
  })
})
