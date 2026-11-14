import { describe, expect, it } from 'vitest'
import { clearanceUnderBar } from '../../../app/utils/editor/promptBarClearance'

const scroller = { top: 100, bottom: 900, left: 0, right: 720 }

describe('clearanceUnderBar', () => {
  it('is zero without a bar', () => {
    expect(clearanceUnderBar(scroller, null)).toBe(0)
  })

  it('keeps the caret line above the bar, with a gap', () => {
    // Bar pill 48px tall, 24px above the editor's bottom edge.
    expect(clearanceUnderBar(scroller, { top: 828, bottom: 876, left: 335, right: 1105 })).toBe(900 - 828 + 16)
  })

  it('is zero when the bar is beside the editor, not over it', () => {
    expect(clearanceUnderBar(scroller, { top: 828, bottom: 876, left: 800, right: 1400 })).toBe(0)
  })

  it('is zero when the bar is below or above the editor', () => {
    expect(clearanceUnderBar(scroller, { top: 910, bottom: 958, left: 0, right: 700 })).toBe(0)
    expect(clearanceUnderBar(scroller, { top: 20, bottom: 68, left: 0, right: 700 })).toBe(0)
  })

  it('never takes more than half the editor (keyboard up on a phone)', () => {
    expect(clearanceUnderBar({ top: 0, bottom: 300, left: 0, right: 375 }, { top: 40, bottom: 88, left: 16, right: 359 })).toBe(150)
  })
})
