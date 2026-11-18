import { describe, expect, it } from 'vitest'
import { aggregateScanItems, findingCommentBody, findingToCommentArgs, ordinalOfUnitId, pickPreviewUnits, unitIdOf } from '../../../../server/utils/ai/tools/delegateHelpers'
import { buildJobUnits } from '../../../../server/utils/ai/jobs/units'
import { relativeRange } from '../../../../server/utils/ai/jobs/runner'
import { makeJobDoc } from './memoryJobStore'

const DOC = [
  '# Eins',
  '',
  'Der erste Absatz über den Kunden und die Lieferung.',
  '',
  '# Zwei',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '# Drei',
  '',
  'Der dritte Absatz. Er ist etwas länger als die anderen, weil er mehr Wörter enthält und den Kunden noch einmal nennt.',
  ''
].join('\n')

describe('unit ids', () => {
  it('round-trips 1-based ids', () => {
    expect(unitIdOf(0)).toBe('u1')
    expect(ordinalOfUnitId('u3')).toBe(2)
    expect(ordinalOfUnitId('3')).toBe(2)
    expect(ordinalOfUnitId('u0')).toBeNull()
    expect(ordinalOfUnitId('x')).toBeNull()
  })
})

describe('pickPreviewUnits', () => {
  const units = buildJobUnits(DOC, 'all', { mode: 'translate', granularity: 'section' })

  it('picks a typical unit and one with a table, in document order', () => {
    const picked = pickPreviewUnits(units, 2)
    expect(picked).toHaveLength(2)
    expect(picked).toContain(1)
    expect([...picked].sort((a, b) => a - b)).toEqual(picked)
  })

  it('returns nothing for 0 and never more than there are units', () => {
    expect(pickPreviewUnits(units, 0)).toEqual([])
    expect(pickPreviewUnits(units, 3)).toHaveLength(3)
    expect(pickPreviewUnits(units.slice(0, 1), 3)).toEqual([0])
  })
})

describe('aggregateScanItems', () => {
  it('merges items across chunks (case and spacing ignored), counts them in the text, most frequent first', () => {
    const { items, distinct } = aggregateScanItems([
      { text: 'Kunden', headingPath: 'Eins', example: 'über den Kunden' },
      { text: 'kunden ', headingPath: 'Drei' },
      { text: 'Lieferung', headingPath: 'Eins' }
    ], DOC, 80)
    expect(distinct).toBe(2)
    expect(items[0]).toEqual({ text: 'Kunden', count: 2, sections: ['Eins', 'Drei'], example: 'über den Kunden' })
    expect(items[1]).toMatchObject({ text: 'Lieferung', count: 1 })
  })

  it('caps the list and keeps the distinct count', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ text: `term${i}`, headingPath: 'X' }))
    const { items, distinct } = aggregateScanItems(many, '', 3)
    expect(items).toHaveLength(3)
    expect(distinct).toBe(10)
  })
})

describe('comment findings → create_comment arguments', () => {
  it('anchors on the lines of a unique quote', () => {
    const doc = makeJobDoc(DOC)
    const unit = buildJobUnits(DOC, 'all', { mode: 'comment', granularity: 'section' }).at(-1)
    const rel = relativeRange(doc.ytext, unit!.start, unit!.end)
    const args = findingToCommentArgs(doc, rel, { quote: 'Er ist etwas länger', issue: 'Zu lang.', suggestion: 'Kürzen.', severity: 'low' })
    expect(args).toEqual({ start_line: 13, end_line: 13, body: 'Zu lang. Suggestion: Kürzen.' })
  })

  it('falls back to the heading line when the quote is missing or not unique', () => {
    const doc = makeJobDoc(DOC)
    const unit = buildJobUnits(DOC, 'all', { mode: 'comment', granularity: 'section' }).at(-1)
    const rel = relativeRange(doc.ytext, unit!.start, unit!.end)
    expect(findingToCommentArgs(doc, rel, { quote: 'nicht da', issue: 'X', severity: 'high' })).toMatchObject({ start_line: 11, end_line: 11 })
    expect(findingToCommentArgs(doc, rel, { quote: 'e', issue: 'X', severity: 'high' })).toMatchObject({ start_line: 11 })
  })

  it('strips mentions and markdown so a job never pings anyone or triggers the AI', () => {
    expect(findingCommentBody({ quote: 'q', issue: '**Ask** @ai and @[Bob](user:7) about it.', severity: 'medium' })).toBe('Ask and about it.')
  })
})
