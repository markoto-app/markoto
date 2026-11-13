import { describe, expect, test } from 'vitest'
import { themeToCss, type ThemeRuntime } from '../../../shared/utils/theme/themeToCss'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import { isValidTheme } from '../../../shared/utils/theme/themeValidation'
import { coverDateFormat, mirrorMargins, numberingDepth, repeatTitle, resolveCaptions, resolveChapterLabel, resolveSectionToken, withThemeDefaults } from '../../../shared/utils/theme/themeOptions'
import { buildCoverHtml, keepCompoundsTogether } from '../../../app/utils/preview/coverHtml'
import type { DocTheme } from '../../../shared/types/theme'

// Engine (structure, running heads, template hooks): `{section}`
// with its number + "start" mode, `{author}`, chapter labels, numbering
// depth + zero-padded numbers, chapter-relative and stacked captions,
// cover affiliations on page covers, the repeated title, date formats,
// mirrored margins, compounds kept whole in the cover title.

const runtime: ThemeRuntime = { title: 'T', date: '6 November 2026', tocTitle: 'Contents' }
const css = (t: DocTheme, rt: ThemeRuntime = runtime) => themeToCss(t, rt)

function theme(edit: (t: DocTheme) => void = () => {}): DocTheme {
  const t = structuredClone(defaultTheme)
  edit(t)
  return t
}

/** A theme stored before these fields existed. */
function legacy(): DocTheme {
  return theme((t) => {
    delete t.page.mirrorMargins
    delete t.headings.numberingDepth
    delete t.headings.chapterLabel
    delete t.headings.chapterWord
    delete t.header.sectionNumber
    delete t.header.sectionMode
    delete t.blocks.captionNumbering
    delete t.blocks.captionLabelStyle
    delete t.cover.dateFormat
    delete t.cover.repeatTitle
  })
}

describe('absent fields = the old look', () => {
  test('a legacy theme validates and renders exactly like one with the defaults spelled out', () => {
    for (const edit of [
      () => {},
      (t: DocTheme) => {
        t.headings.numbering = 'decimal'
        t.header.left = '{section}'
        t.tables.captionLabel = true
        t.blocks.figureLabel = true
      }
    ]) {
      const t = legacy()
      edit(t)
      expect(isValidTheme(t)).toBe(true)
      expect(css(t)).toBe(css(withThemeDefaults(t)))
    }
    const t = legacy()
    expect(resolveSectionToken(t)).toEqual({ number: false, mode: 'first' })
    expect(resolveChapterLabel(t)).toEqual({ enabled: false, word: '' })
    expect(numberingDepth(t)).toBe(4)
    expect(coverDateFormat(t)).toBe('locale')
    expect(repeatTitle(t)).toBe(false)
    expect(mirrorMargins(t)).toBe(false)
    expect(resolveCaptions(t).numbering).toBe('document')
    expect(resolveCaptions(t).labelStyle).toBe('inline')
  })

  test('withThemeDefaults spells every new field out', () => {
    const filled = withThemeDefaults(legacy())
    expect(filled.header).toMatchObject({ sectionNumber: false, sectionMode: 'first' })
    expect(filled.headings).toMatchObject({ numberingDepth: 4, chapterLabel: false, chapterWord: '' })
    expect(filled.blocks).toMatchObject({ captionNumbering: 'document', captionLabelStyle: 'inline' })
    expect(filled.cover).toMatchObject({ dateFormat: 'locale', repeatTitle: false })
    expect(filled.page.mirrorMargins).toBe(false)
  })

  test('the old `{section}` rule is unchanged without the new options', () => {
    const t = legacy()
    t.header.left = '{section}'
    expect(css(t)).toContain('.paged-doc .markoto-section-heading { string-set: mk-section content(text); }')
    expect(css(t)).toContain('content: string(mk-section);')
  })
})

describe('validation', () => {
  test('accepts the new values', () => {
    expect(isValidTheme(theme((t) => {
      t.headings.numbering = 'decimal-zero'
      t.headings.numberingDepth = 1
      t.headings.chapterLabel = true
      t.headings.chapterWord = 'Kapitel'
      t.header.sectionNumber = true
      t.header.sectionMode = 'start'
      t.header.left = '{author} · {section}'
      t.blocks.captionNumbering = 'chapter'
      t.blocks.captionLabelStyle = 'stacked'
      t.cover.dateFormat = 'us'
      t.cover.repeatTitle = true
      t.page.mirrorMargins = true
      t.body.dropCap = 'every-chapter'
    }))).toBe(true)
  })

  test('rejects unknown values and unsafe chapter words', () => {
    const t = theme()
    expect(isValidTheme({ ...t, headings: { ...t.headings, numberingDepth: 5 } })).toBe(false)
    expect(isValidTheme({ ...t, headings: { ...t.headings, numbering: 'zero' } })).toBe(false)
    expect(isValidTheme({ ...t, headings: { ...t.headings, chapterWord: 'Ch"apter' } })).toBe(false)
    expect(isValidTheme({ ...t, headings: { ...t.headings, chapterWord: 'x'.repeat(41) } })).toBe(false)
    expect(isValidTheme({ ...t, header: { ...t.header, sectionMode: 'last' } })).toBe(false)
    expect(isValidTheme({ ...t, footer: { ...t.footer, sectionMode: 'start' } })).toBe(false)
    expect(isValidTheme({ ...t, blocks: { ...t.blocks, captionNumbering: 'section' } })).toBe(false)
    expect(isValidTheme({ ...t, blocks: { ...t.blocks, captionLabelStyle: 'block' } })).toBe(false)
    expect(isValidTheme({ ...t, cover: { ...t.cover, dateFormat: 'eu' } })).toBe(false)
    expect(isValidTheme({ ...t, body: { ...t.body, dropCap: 'every-section' } })).toBe(false)
    expect(isValidTheme({ ...t, header: { ...t.header, left: '{authors}"' } })).toBe(false)
  })
})

describe('{section} token', () => {
  const withSection = (edit: (t: DocTheme) => void = () => {}) => theme((t) => {
    t.header.left = '{section}'
    edit(t)
  })

  test('sectionNumber reads the number + title from the heading attribute (paged.js string-set supports attr())', () => {
    const out = css(withSection((t) => {
      t.header.sectionNumber = true
    }))
    expect(out).toContain('.paged-doc .markoto-section-heading { string-set: mk-section attr(data-markoto-section); }')
  })

  test('sectionMode start names the section the page starts in', () => {
    const out = css(withSection((t) => {
      t.header.sectionMode = 'start'
    }))
    expect(out).toContain('content: string(mk-section, start);')
    expect(css(withSection())).toContain('content: string(mk-section);')
  })

  test('the footer token follows the header options too', () => {
    const out = css(theme((t) => {
      t.footer.center = '{section}'
      t.header.sectionMode = 'start'
    }))
    expect(out).toMatch(/@bottom-center \{\s*content: string\(mk-section, start\);/)
  })
})

describe('{author} token', () => {
  test('prints the cover authors, comma-separated, as a CSS string', () => {
    const out = css(theme((t) => {
      t.header.left = 'By {author}'
      t.cover.authors = ['Ada Lovelace', ' ', 'Charles Babbage']
    }))
    expect(out).toContain('content: "By " "Ada Lovelace, Charles Babbage";')
  })
})

describe('heading numbers', () => {
  test('decimal-zero: two-digit top level, plain levels below', () => {
    const out = css(theme((t) => {
      t.headings.numbering = 'decimal-zero'
    }))
    expect(out).toContain('content: counter(mk-h1, decimal-leading-zero);')
    expect(out).toContain('content: counter(mk-h1, decimal-leading-zero) "." counter(mk-h2);')
    // A document whose sections are h2 counts from there.
    expect(out).toContain('.paged-doc h2.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2, decimal-leading-zero); }')
  })

  test('numberingDepth 1: every level still counts, only the top level shows a number', () => {
    const out = css(theme((t) => {
      t.headings.numbering = 'decimal'
      t.headings.numberingDepth = 1
    }))
    expect(out).toContain('counter-increment: mk-h2;')
    expect(out).toMatch(/\.paged-doc h1:not\(\.markoto-cover-title\):not\(\.markoto-abstract-heading\):not\(\.unnumbered\)::before \{/)
    expect(out).not.toMatch(/\.paged-doc h2:not\(\.markoto-cover-title\):not\(\.markoto-abstract-heading\):not\(\.unnumbered\)::before/)
    expect(out).toContain('.paged-doc h2.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2); }')
    expect(out).not.toContain('h3.markoto-num-from-h2')
    // TOC: only the first level numbered.
    expect(out).toContain('.paged-doc .table-of-contents > ul > li:not(.markoto-abstract-entry):not(.markoto-unnumbered-entry)::before')
    expect(out).not.toContain('.paged-doc .table-of-contents > ul > li > ul > li:not(.markoto-abstract-entry):not(.markoto-unnumbered-entry)::before')
  })

  test('chapter label: the language word (runtime) over the number, on a line of its own', () => {
    const t = theme((th) => {
      th.headings.numbering = 'decimal'
      th.headings.chapterLabel = true
    })
    const de = css(t, { ...runtime, captionLabels: { table: 'Tabelle', figure: 'Abbildung', separator: ': ', chapter: { before: 'Kapitel ', after: '' } } })
    expect(de).toMatch(/\.paged-doc h1\.markoto-section-heading:not\(\.markoto-cover-title\):not\(\.markoto-abstract-heading\):not\(\.unnumbered\)::before \{\s*content: "Kapitel " counter\(mk-h1, decimal\);\s*display: block;/)
    expect(de).toContain('content: "Kapitel " counter(mk-h2, decimal);')
    const ja = css(t, { ...runtime, captionLabels: { table: '表', figure: '図', separator: ': ', chapter: { before: '第', after: '章' } } })
    expect(ja).toContain('content: "第" counter(mk-h1, decimal) "章";')
    // No runtime labels: English.
    expect(css(t)).toContain('content: "Chapter " counter(mk-h1, decimal);')
  })

  test('chapter label: the author\'s word wins; ieee / decimal-zero number formats; nothing without numbering', () => {
    const word = css(theme((t) => {
      t.headings.numbering = 'ieee'
      t.headings.chapterLabel = true
      t.headings.chapterWord = 'Part'
    }))
    expect(word).toContain('content: "Part " counter(mk-h1, upper-roman);')
    const zero = css(theme((t) => {
      t.headings.numbering = 'decimal-zero'
      t.headings.chapterLabel = true
    }))
    expect(zero).toContain('content: "Chapter " counter(mk-h1, decimal-leading-zero);')
    const off = css(theme((t) => {
      t.headings.chapterLabel = true
    }))
    expect(off).not.toContain('"Chapter "')
  })
})

describe('captions', () => {
  test('chapter numbering prints the number composeFinalHtml writes on the caption', () => {
    const out = css(theme((t) => {
      t.tables.captionLabel = true
      t.blocks.figureLabel = true
      t.blocks.captionNumbering = 'chapter'
    }))
    expect(out).toContain('.paged-doc table > caption::before { content: "Table " attr(data-markoto-number) ": "; }')
    expect(out).toContain('.paged-doc figcaption:not(:empty)::before { content: "Figure " attr(data-markoto-number) ": "; }')
    // The counters still advance (template CSS may use them).
    expect(out).toContain('counter-increment: mk-table;')
  })

  test('stacked labels: bold, upright, in the text colour, on their own line, no separator', () => {
    const out = css(theme((t) => {
      t.tables.captionLabel = true
      t.blocks.figureLabel = true
      t.blocks.captionLabelStyle = 'stacked'
    }))
    expect(out).toContain('.paged-doc table > caption::before { content: "Table " counter(mk-table); display: block; font-style: normal; font-weight: 700; color: var(--doc-text); }')
    expect(out).toContain('.paged-doc figcaption:not(:empty)::before { content: "Figure " counter(mk-figure); display: block; font-style: normal; font-weight: 700; color: var(--doc-text); }')
  })
})

describe('cover', () => {
  const page = (edit: (t: DocTheme) => void = () => {}) => theme((t) => {
    t.cover.layout = 'classic'
    t.cover.showAuthors = true
    t.cover.authors = ['Elena Marchetti', 'Bo Chen']
    edit(t)
  })

  test('page covers show each author\'s affiliation under the name', () => {
    const t = page((th) => {
      th.cover.affiliations = ['Institute of Hydraulic Engineering\nUniversity of Valmont']
    })
    const html = buildCoverHtml(t, 'Title', '1 May 2026')
    expect(html).toContain('<div class="markoto-cover-author">Elena Marchetti</div><div class="markoto-cover-affiliation">Institute of Hydraulic Engineering\nUniversity of Valmont</div><div class="markoto-cover-author">Bo Chen</div>')
    expect(css(t)).toMatch(/\.paged-doc \.markoto-cover-affiliation \{\s*white-space: pre-line;/)
    // No affiliations: neither markup nor CSS.
    expect(buildCoverHtml(page(), 'Title', '1 May 2026')).not.toContain('affiliation')
    expect(css(page())).not.toContain('markoto-cover-affiliation')
  })

  test('repeatTitle puts the title again after a title page or title block, as a non-heading', () => {
    const t = page((th) => {
      th.cover.repeatTitle = true
    })
    expect(buildCoverHtml(t, 'Who Owns <the> Shoreline?', '')).toMatch(/<\/section><div class="markoto-repeat-title">Who Owns &lt;the&gt; Shoreline\?<\/div>$/)
    expect(css(t)).toMatch(/\.paged-doc \.markoto-repeat-title \{[^}]*font-weight: 700;[^}]*text-align: center;/)
    const block = page((th) => {
      th.cover.layout = 'title-block'
      th.cover.repeatTitle = true
    })
    expect(buildCoverHtml(block, 'Essay', '')).toMatch(/<\/section><div class="markoto-repeat-title">Essay<\/div>$/)
    expect(buildCoverHtml(page(), 'Essay', '')).not.toContain('markoto-repeat-title')
    expect(css(page())).not.toContain('markoto-repeat-title')
    // Not without a cover or with the title switched off.
    expect(buildCoverHtml(page((th) => {
      th.cover.repeatTitle = true
      th.cover.showTitle = false
    }), 'Essay', '')).not.toContain('markoto-repeat-title')
  })

  test('hyphenated compounds in the title never break at the hyphen', () => {
    expect(keepCompoundsTogether('Fieldnote \u2014 field-service reports in one tap')).toBe('Fieldnote \u2014 <span class="markoto-nobreak">field-service</span> reports in one tap')
    expect(keepCompoundsTogether('state-of-the-art X-ray Q3-2026')).toBe('<span class="markoto-nobreak">state-of-the-art</span> <span class="markoto-nobreak">X-ray</span> <span class="markoto-nobreak">Q3-2026</span>')
    // Escaped text stays intact; a lone or spaced dash is no compound.
    expect(keepCompoundsTogether('A &amp; B - C -- D')).toBe('A &amp; B - C -- D')
    expect(buildCoverHtml(page(), 'Fieldnote \u2014 field-service reports', '')).toContain('<h1 class="markoto-cover-title">Fieldnote \u2014 <span class="markoto-nobreak">field-service</span> reports</h1>')
    expect(css(page())).toContain('.paged-doc .markoto-cover-title .markoto-nobreak { white-space: nowrap; }')
  })
})

describe('mirrored margins', () => {
  test('left pages swap the side margins', () => {
    const out = css(theme((t) => {
      t.page.marginLeft = 30
      t.page.marginRight = 18
      t.page.mirrorMargins = true
    }))
    expect(out).toMatch(/@page :left \{\s*margin-left: 18mm;\s*margin-right: 30mm;\s*\}/)
  })

  test('nothing to mirror with equal sides, or with the option off', () => {
    expect(css(theme((t) => {
      t.page.mirrorMargins = true
    }))).not.toContain('@page :left')
    expect(css(theme((t) => {
      t.page.marginLeft = 30
    }))).not.toContain('@page :left')
  })
})
