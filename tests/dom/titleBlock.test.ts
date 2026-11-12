import { describe, it, expect } from 'vitest'
import { dropTitleHeading, extractAbstract, markAbstract } from '../../app/utils/preview/titleBlock'
import { buildCoverHtml } from '../../app/utils/preview/coverHtml'
import { pruneTocDepth } from '../../app/utils/preview/tocDepth'
import { THEME_PRESETS } from '../../shared/utils/theme/themePresets'
import type { DocTheme } from '../../shared/types/theme'

const body = '<nav class="table-of-contents"><ul><li><a href="#abstract">Abstract</a></li><li><a href="#intro">Intro</a></li></ul></nav>'
  + '<h2 id="abstract">Abstract</h2><p>We measure.</p><p><strong>Keywords</strong> a · b</p>'
  + '<h1 id="intro">Intro</h1><p>Text.</p>'

function arxiv(): DocTheme {
  const preset = THEME_PRESETS.find(p => p.id === 'arxiv')
  if (!preset) throw new Error('arxiv preset missing')
  return structuredClone(preset.theme)
}

describe('extractAbstract', () => {
  it('moves the leading Abstract section out of the body, TOC entry included', () => {
    const { abstractHtml, bodyHtml } = extractAbstract(body)
    expect(abstractHtml).toBe('<div class="markoto-abstract-title">Abstract</div><p>We measure.</p><p><strong>Keywords</strong> a · b</p>')
    expect(bodyHtml).not.toContain('We measure')
    expect(bodyHtml).not.toContain('href="#abstract"')
    expect(bodyHtml).toContain('<h1 id="intro">Intro</h1>')
  })

  it('recognises the UI languages and a trailing colon', () => {
    for (const name of ['Zusammenfassung', 'Résumé:', 'Resumen', '概要', '摘要']) {
      expect(extractAbstract(`<h2>${name}</h2><p>x</p><h2>Next</h2>`).abstractHtml, name).toContain('<p>x</p>')
    }
  })

  it('ignores an "Abstract" heading that is not the first heading', () => {
    const html = '<h1>Intro</h1><p>a</p><h2>Abstract</h2><p>b</p>'
    expect(extractAbstract(html)).toEqual({ abstractHtml: '', bodyHtml: html })
  })
})

describe('markAbstract', () => {
  it('marks the heading and its TOC entry so heading numbers skip them', () => {
    const out = markAbstract(body)
    expect(out).toContain('<h2 id="abstract" class="markoto-abstract-heading">')
    expect(out).toContain('<li class="markoto-abstract-entry"><a href="#abstract">')
  })
})

describe('buildCoverHtml: title-block layout', () => {
  it('title, subtitle, author cards with affiliations, date and the abstract', () => {
    const theme = arxiv()
    theme.cover.showSubtitle = true
    theme.cover.subtitle = 'A preprint'
    theme.cover.authors = ['Ada <b>Kovač</b>', ' ', 'Jonas Meier']
    theme.cover.affiliations = ['Dept. A\nUni A', '', '']
    const html = buildCoverHtml(theme, 'Queues', '6 November 2026', '<div class="markoto-abstract-title">Abstract</div><p>x</p>')
    expect(html.startsWith('<section class="markoto-cover markoto-title-block">')).toBe(true)
    expect(html).toContain('<h1 class="markoto-cover-title">Queues</h1>')
    expect(html).toContain('<div class="markoto-cover-subtitle">A preprint</div>')
    expect(html).toContain('<div class="markoto-cover-author">Ada &lt;b&gt;Kovač&lt;/b&gt;</div><div class="markoto-cover-affiliation">Dept. A\nUni A</div>')
    expect(html).toContain('<div class="markoto-cover-author">Jonas Meier</div></div>')
    expect(html).toContain('<div class="markoto-cover-date">6 November 2026</div>')
    expect(html).toContain('<div class="markoto-abstract"><div class="markoto-abstract-title">Abstract</div><p>x</p></div>')
  })

  it('renders nothing when there is nothing to show', () => {
    const theme = arxiv()
    theme.cover.showTitle = false
    theme.cover.showSubtitle = false
    theme.cover.showAuthors = false
    theme.cover.showDate = false
    expect(buildCoverHtml(theme, 'T', 'd')).toBe('')
  })
})

describe('pruneTocDepth', () => {
  const toc = '<nav class="table-of-contents"><ul><li><a href="#a">A</a><ul><li><a href="#b">B</a><ul><li><a href="#c">C</a></li></ul></li></ul></li><li><a href="#d">D</a></li></ul></nav><h1 id="a">A</h1>'

  it('removes levels below maxDepth (paged.js mis-measured hidden ones)', () => {
    const out = pruneTocDepth(toc, 2)
    expect(out).toContain('href="#b"')
    expect(out).not.toContain('href="#c"')
    expect(out).toContain('href="#d"')
    expect(out).toContain('<h1 id="a">A</h1>')
  })

  it('leaves a depth-4 TOC and documents without one untouched', () => {
    expect(pruneTocDepth(toc, 4)).toBe(toc)
    expect(pruneTocDepth('<p>x</p>', 2)).toBe('<p>x</p>')
  })
})

describe('dropTitleHeading: no duplicate title in title-block layouts', () => {
  const doc = '<nav class="table-of-contents"><ul><li><a href="#edge-cache">Edge cache</a></li><li><a href="#intro">Intro</a></li></ul></nav>'
  const titled = '<h1 id="edge-cache">Edge  cache\n behaviour</h1><h2 id="abstract">Abstract</h2><p>We measure.</p><h1 id="intro">Intro</h1>'

  it('drops a leading h1 that repeats the title (normalised), with its TOC entry', () => {
    const out = dropTitleHeading(titled + doc, 'edge cache Behaviour')
    expect(out).not.toContain('id="edge-cache"')
    expect(out).not.toContain('href="#edge-cache"')
    expect(out).toContain('<h1 id="intro">Intro</h1>')
  })

  it('leaves a different first h1, a later h1 and an empty title alone', () => {
    expect(dropTitleHeading('<h1>Introduction</h1><p>x</p>', 'My paper')).toBe('<h1>Introduction</h1><p>x</p>')
    expect(dropTitleHeading('<p>Intro</p><h1>My paper</h1>', 'My paper')).toBe('<p>Intro</p><h1>My paper</h1>')
    expect(dropTitleHeading('<h2>My paper</h2>', 'My paper')).toBe('<h2>My paper</h2>')
    expect(dropTitleHeading('<h1>My paper</h1>', '  ')).toBe('<h1>My paper</h1>')
  })
})
