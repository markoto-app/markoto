import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { attrs } from '@mdit/plugin-attrs'
import { tableAttrsRowPlugin } from '../../../app/utils/markdown/markdownTableAttrs'

// Same plugin order as renderMarkdown: attrs first, the table rule later.
const md = new MarkdownIt().use(attrs).use(tableAttrsRowPlugin)

const TABLE = '| a | b |\n|---|--:|\n| x | 1 |\n'

describe('tableAttrsRowPlugin — `{.class}` right under a table', () => {
  it('applies the attributes to the table instead of adding an empty row', () => {
    const html = md.render(`${TABLE}{.financials}\n`)
    expect(html).toContain('<table class="financials">')
    expect(html).not.toContain('<td class="financials">')
    expect(html.match(/<tr>/g)).toHaveLength(2)
  })

  it('keeps the blank-line spelling working and supports ids + several classes', () => {
    expect(md.render(`${TABLE}\n{.wide}\n`)).toContain('<table class="wide">')
    expect(md.render(`${TABLE}{#t1 .a .b}\n`)).toMatch(/<table (?:id="t1" class="a b"|class="a b" id="t1")>/)
  })

  it('leaves real rows alone', () => {
    for (const row of ['| {not attrs} | 2 |', '| {.x} | not empty |', '| plain | row |']) {
      const html = md.render(`${TABLE}${row}\n`)
      expect(html, row).toMatch(/<table>/)
      expect(html.match(/<tr>/g), row).toHaveLength(3)
    }
  })

  it('never removes the only body row', () => {
    const html = md.render('| a | b |\n|---|---|\n| {.x} | |\n')
    expect(html).toContain('<tbody>')
  })
})
