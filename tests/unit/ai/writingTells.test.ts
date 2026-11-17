import { describe, it, expect } from 'vitest'
import { EM_DASH_TELL, findAiWritingTells } from '../../../shared/ai/writingTells'

describe('findAiWritingTells', () => {
  it('returns nothing for plain prose', () => {
    expect(findAiWritingTells('The report covers three regions. Sales rose 4 % in 2024 (from 2019--2023 they were flat).')).toEqual([])
  })

  it('flags the em-dash', () => {
    expect(findAiWritingTells('Sales rose \u2014 slightly.')).toEqual([EM_DASH_TELL])
  })

  it('flags AI vocabulary in any inflection and case, once each, em-dash first', () => {
    const text = 'Delving into the data, we delve deeper. It is a Testament to the team\u2014and it underscores a vibrant, intricate tapestry. In conclusion, I hope this helps.'
    expect(findAiWritingTells(text)).toEqual([EM_DASH_TELL, 'delve', 'tapestry', 'testament', 'underscore', 'vibrant', 'intricate', 'in conclusion', 'i hope this helps'])
  })

  it('matches whole words only and skips legitimate uses', () => {
    expect(findAiWritingTells('A garnet ring from the Old Testament.')).toEqual([])
    expect(findAiWritingTells('Across realms.')).toEqual(['realm'])
  })
})
