import { describe, expect, it } from 'vitest'
import { diagramKind, finishMermaidSvg, formatAxisNumber, formatPieLegendLabel, thinAxisTicks } from '../../app/utils/markdown/mermaidLoader'

// What mermaid 11 hands back for a pie with `showData` (trimmed): the SVG
// still uses useMaxWidth-style sizing and the legend carries raw values.
const PIE = '<svg id="mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 631.25 450" style="max-width: 631.25px;" role="graphics-document document" aria-roledescription="pie">'
  + '<g class="legend"><rect/><text>DACH [3320]</text></g><g class="legend"><rect/><text>Rest of Europe [390]</text></g></svg>'

const XY = '<svg id="mmd-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 643 296" aria-roledescription="xychart">'
  + '<g class="left-axis"><g class="label"><text>7000</text><text>500</text></g><g class="title"><text>EUR k</text></g></g>'
  + '<g class="bottom-axis"><g class="label"><text>Q3 25</text></g></g></svg>'

describe('finishMermaidSvg', () => {
  it('gives the SVG an explicit pixel size from its viewBox', () => {
    const out = finishMermaidSvg(PIE, 'en')
    expect(out.width).toBe(632)
    expect(out.height).toBe(450)
    expect(out.svg).toContain('width="632"')
    expect(out.svg).toContain('height="450"')
    expect(out.svg).not.toContain('max-width')
    expect(out.kind).toBe('pie')
  })

  it('formats pie legend values and xy-chart ticks for the document language', () => {
    expect(finishMermaidSvg(PIE, 'en').svg).toContain('DACH  3,320')
    expect(finishMermaidSvg(PIE, 'de').svg).toContain('DACH  3.320')
    const xy = finishMermaidSvg(XY, 'en').svg
    expect(xy).toContain('>7,000<')
    expect(xy).toContain('>500<')
    expect(xy).toContain('>EUR k<')
    expect(xy).toContain('>Q3 25<')
  })

  it('returns well-formed XML (an SVG <img> is parsed as XML)', () => {
    const withBr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">a<br>b</div></foreignObject></svg>'
    const parsed = new DOMParser().parseFromString(finishMermaidSvg(withBr, 'en').svg, 'image/svg+xml')
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0)
  })

  it('passes non-SVG input through', () => {
    expect(finishMermaidSvg('nope', 'en')).toEqual({ svg: 'nope', width: null, height: null, kind: '' })
  })
})

describe('number formatting helpers', () => {
  it('formatPieLegendLabel only rewrites the `Label [value]` shape', () => {
    expect(formatPieLegendLabel('UK & Ireland [650]', 'en')).toBe('UK & Ireland  650')
    expect(formatPieLegendLabel('Big [1234567.5]', 'en')).toBe('Big  1,234,567.5')
    expect(formatPieLegendLabel('No value', 'en')).toBe('No value')
    expect(formatPieLegendLabel('Bad [1234]', 'not a locale!!')).toBe('Bad  1,234')
  })

  it('formatAxisNumber leaves small numbers and text alone', () => {
    expect(formatAxisNumber('12500', 'de')).toBe('12.500')
    expect(formatAxisNumber('-2500', 'en')).toBe('-2,500')
    expect(formatAxisNumber('999', 'en')).toBe('999')
    expect(formatAxisNumber('Q3 25', 'en')).toBe('Q3 25')
  })

  it('diagramKind is a class-safe token', () => {
    const svg = new DOMParser().parseFromString('<svg aria-roledescription="flowchart-v2&quot; onload=x"></svg>', 'text/html').querySelector('svg')
    expect(svg && diagramKind(svg)).toBe('flowchart-v2onloadx')
  })
})

describe('thinAxisTicks', () => {
  function axis(values: string[]): Element {
    const labels = values.map(v => `<text>${v}</text>`).join('')
    const ticks = values.map(() => '<path/>').join('')
    const doc = new DOMParser().parseFromString(`<svg><g class="left-axis"><g class="label">${labels}</g><g class="ticks">${ticks}</g></g></svg>`, 'text/html')
    const g = doc.querySelector('g.left-axis')
    if (!g) throw new Error('fixture')
    return g
  }
  const texts = (g: Element) => Array.from(g.querySelectorAll('g.label text')).map(t => t.textContent)

  it('thins 0–7000 in steps of 500 to steps of 1000 (labels and tick marks)', () => {
    const g = axis(Array.from({ length: 15 }, (_, i) => String(7000 - i * 500)))
    thinAxisTicks(g)
    expect(texts(g)).toEqual(['7000', '6000', '5000', '4000', '3000', '2000', '1000', '0'])
    expect(g.querySelectorAll('g.ticks path')).toHaveLength(8)
  })

  it('leaves short axes and category axes alone', () => {
    const short = axis(['0', '1000', '2000', '3000'])
    thinAxisTicks(short)
    expect(texts(short)).toHaveLength(4)
    const cats = axis(Array.from({ length: 12 }, (_, i) => `Q${i}`))
    thinAxisTicks(cats)
    expect(texts(cats)).toHaveLength(12)
  })

  it('applies inside finishMermaidSvg', () => {
    const labels = Array.from({ length: 15 }, (_, i) => `<text>${i * 500}</text>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-roledescription="xychart"><g class="left-axis"><g class="label">${labels}</g></g></svg>`
    const out = finishMermaidSvg(svg, 'en').svg
    expect(out).toContain('>7,000<')
    expect(out).not.toContain('>6,500<')
  })
})
