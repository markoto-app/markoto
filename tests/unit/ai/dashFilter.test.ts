import { describe, expect, it } from 'vitest'
import { EM_DASH, filterEmDashes, filterEmDashesAt } from '../../../server/utils/ai/dashFilter'

const D = EM_DASH
const EN = '–'

function f(text: string): string {
  return filterEmDashes(text).text
}

describe('filterEmDashes', () => {
  it('leaves text without an em-dash untouched', () => {
    expect(filterEmDashes('Plain text -- and --- stay.')).toEqual({ text: 'Plain text -- and --- stay.', replaced: 0 })
  })

  it('turns a dash between words into a comma, spaced or not', () => {
    expect(f(`Das Team ${D} drei Personen ${D} arbeitet remote.`)).toBe('Das Team, drei Personen, arbeitet remote.')
    expect(f(`Wort${D}Wort`)).toBe('Wort, Wort')
  })

  it('collapses double punctuation', () => {
    expect(f(`Er sagte: ${D} nein.`)).toBe('Er sagte: nein.')
    expect(f(`Wort ${D}, dann`)).toBe('Wort, dann')
    expect(f(`(siehe oben ${D})`)).toBe('(siehe oben)')
  })

  it('makes a range between digits an en-dash', () => {
    expect(f(`Von 2019${D}2024 und 3 ${D} 5 Seiten.`)).toBe(`Von 2019${EN}2024 und 3${EN}5 Seiten.`)
  })

  it('makes a placeholder in a table cell an en-dash', () => {
    expect(f(`| A | B |\n| --- | --- |\n| ${D} | x ${D} y |\n|${D}|1${D}2|`))
      .toBe(`| A | B |\n| --- | --- |\n| ${EN} | x, y |\n|${EN}|1${EN}2|`)
    expect(f(`| Status | ${D} offen |`)).toBe(`| Status | ${EN} offen |`)
  })

  it('makes a dash at the start of a line or list item an en-dash', () => {
    expect(f(`- ${D} offen\n1. ${D}\n${D} Zitat\n> ${D} Quelle`)).toBe(`- ${EN} offen\n1. ${EN}\n${EN} Zitat\n> ${EN} Quelle`)
  })

  it('drops a dash at the end of a line or cell', () => {
    expect(f(`- Punkt ${D}\n| a ${D} | b |`)).toBe('- Punkt\n| a | b |')
  })

  it('leaves code, math, URLs and link targets alone', () => {
    const text = `Code \`a${D}b\` and [link](http://x.y/a${D}b) and $a${D}b$ and https://x.y/${D}z`
    expect(f(text)).toBe(text)
    const fence = `\`\`\`\nx${D}y\n\`\`\`\n\nProse ${D} here`
    expect(f(fence)).toBe(`\`\`\`\nx${D}y\n\`\`\`\n\nProse, here`)
  })

  it('leaves thematic breaks and table delimiter rows alone', () => {
    const text = '---\n\n| a | b |\n| --- | --- |\n| 1 -- 2 | x |'
    expect(f(text)).toBe(text)
  })

  it('treats a run of em-dashes as one', () => {
    expect(f(`A ${D}${D} B`)).toBe('A, B')
  })

  it('changes only the offsets `allow` admits', () => {
    const text = `alt ${D} alt, neu ${D} neu`
    const at = text.lastIndexOf(D)
    expect(filterEmDashes(text, { allow: o => o === at }).text).toBe(`alt ${D} alt, neu, neu`)
  })
})

describe('filterEmDashesAt', () => {
  it('leaves a fragment inside a code block of the document alone', () => {
    const doc = '```\nline one\nline two\n```\n\nProse.\n'
    expect(filterEmDashesAt(doc, doc.indexOf('line two'), `a ${D} b`)).toBe(`a ${D} b`)
    expect(filterEmDashesAt(doc, doc.indexOf('Prose'), `a ${D} b`)).toBe('a, b')
  })
})
