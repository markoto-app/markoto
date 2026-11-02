import { describe, expect, it } from 'vitest'
import { toWellFormedSvg } from '../../app/utils/mermaidLoader'

// Shape of what mermaid 11 returns for `A["One<br/>Two"]`: the label sits in
// a foreignObject and is serialised as HTML, so the line break is `<br>`.
const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
  + '<g><foreignObject width="40" height="30"><div xmlns="http://www.w3.org/1999/xhtml">'
  + '<span class="nodeLabel"><p>One<br>Two &amp; three</p></span></div></foreignObject></g></svg>'

function isWellFormedXml(s: string): boolean {
  const parsed = new DOMParser().parseFromString(s, 'image/svg+xml')
  return parsed.getElementsByTagName('parsererror').length === 0
}

describe('toWellFormedSvg', () => {
  it('turns mermaid\'s HTML-serialised labels into well-formed XML', () => {
    expect(isWellFormedXml(MERMAID_SVG)).toBe(false)
    const out = toWellFormedSvg(MERMAID_SVG)
    expect(isWellFormedXml(out)).toBe(true)
    expect(out).toMatch(/One<br\s*\/>Two &amp; three/)
    expect(out).toContain('viewBox="0 0 100 50"')
  })

  it('leaves input without an <svg> element unchanged', () => {
    expect(toWellFormedSvg('not an svg')).toBe('not an svg')
  })
})
