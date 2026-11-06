import { describe, expect, test } from 'vitest'
import { themeToCss, type ThemeRuntime } from '../../shared/utils/themeToCss'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { isValidTheme } from '../../shared/utils/themeValidation'
import { referenceStyle, resolveCaptions, resolveHeadingLevel, resolvePageMargins, withThemeDefaults } from '../../shared/utils/themeOptions'
import { textColumnWidthPx } from '../../shared/utils/mermaidConfig'
import { captionLabelsFor } from '../../shared/utils/documentLocale'
import { nowrapRuns } from '../../app/utils/markdownTables'
import type { DocTheme } from '../../shared/types/theme'

// Document-structure theme fields (engine batch after the template wave):
// numbering styles + numbering base, per-level alignment, per-side page
// margins, table / figure captions, the reference list, `{section}`, the
// font variables, the first-section marker, the balanced cover title.

const runtime: ThemeRuntime = { title: 'T', date: '6 November 2026', tocTitle: 'Contents' }

function theme(edit: (t: DocTheme) => void = () => {}): DocTheme {
  const t = structuredClone(defaultTheme)
  edit(t)
  return t
}

/** A theme stored before these fields existed. */
function legacy(): DocTheme {
  const t = theme()
  delete t.tables.captionPosition
  delete t.tables.captionLabel
  delete t.blocks.figureLabel
  delete t.blocks.referenceStyle
  return t
}

const css = (t: DocTheme, rt: ThemeRuntime = runtime) => themeToCss(t, rt)

describe('optional fields', () => {
  test('a theme without them validates and renders like one with the defaults spelled out', () => {
    const t = legacy()
    expect(isValidTheme(t)).toBe(true)
    expect(css(t)).toBe(css(withThemeDefaults(t)))
    expect(resolveCaptions(t)).toEqual({ tablePosition: 'above', tableLabel: false, figureLabel: false })
    expect(referenceStyle(t)).toBe('plain')
    expect(resolvePageMargins(t)).toEqual({ top: 24, right: 24, bottom: 24, left: 24 })
  })

  test('withThemeDefaults fills captions + reference style, leaves the per-side margins absent (they follow page.margin)', () => {
    const filled = withThemeDefaults(legacy())
    expect(filled.tables.captionPosition).toBe('above')
    expect(filled.tables.captionLabel).toBe(false)
    expect(filled.blocks.figureLabel).toBe(false)
    expect(filled.blocks.referenceStyle).toBe('plain')
    expect('marginTop' in filled.page).toBe(false)
  })

  test('the schema accepts the new values and rejects others', () => {
    expect(isValidTheme(theme((t) => {
      t.headings.numbering = 'ieee'
    }))).toBe(true)
    expect(isValidTheme(theme((t) => {
      t.headings.numbering = 'decimal-dot'
    }))).toBe(true)
    expect(isValidTheme({ ...theme(), headings: { ...theme().headings, numbering: 'roman' } })).toBe(false)
    expect(isValidTheme(theme((t) => {
      t.headings.levels = { h1: { align: 'center' } }
    }))).toBe(true)
    expect(isValidTheme({ ...theme(), headings: { ...theme().headings, levels: { h1: { align: 'right' } } } })).toBe(false)
    expect(isValidTheme(theme((t) => {
      t.page.marginBottom = 30
    }))).toBe(true)
    expect(isValidTheme(theme((t) => {
      t.page.marginTop = 61
    }))).toBe(false)
    expect(isValidTheme({ ...theme(), tables: { ...theme().tables, captionPosition: 'left' } })).toBe(false)
    expect(isValidTheme({ ...theme(), blocks: { ...theme().blocks, referenceStyle: 'apa' } })).toBe(false)
    expect(isValidTheme(theme((t) => {
      t.header.left = '{section} · {title}'
    }))).toBe(true)
    expect(isValidTheme(theme((t) => {
      t.header.left = '{section}"'
    }))).toBe(false)
  })

  test('presets that leave the new fields at their defaults render exactly as before', () => {
    for (const p of THEME_PRESETS) {
      const t = structuredClone(p.theme)
      if (t.tables.captionLabel || t.blocks.figureLabel || t.blocks.referenceStyle !== 'plain') continue
      const out = css(t)
      expect(out, p.id).not.toContain('mk-table')
      expect(out, p.id).not.toContain('mk-figure')
      expect(out, p.id).not.toContain('markoto-references')
      expect(out, p.id).not.toContain('string-set')
    }
  })
})

describe('heading numbers', () => {
  const numbered = (style: DocTheme['headings']['numbering']) => css(theme((t) => {
    t.cover.enabled = false
    t.headings.numbering = style
  }))

  test('decimal is unchanged: 1, 1.1, 1.1.1', () => {
    const out = numbered('decimal')
    expect(out).toContain('content: counter(mk-h1) "." counter(mk-h2) "." counter(mk-h3);')
    expect(out).toContain('margin-right: 0.75em;')
  })

  test('decimal-dot closes every number with a dot', () => {
    const out = numbered('decimal-dot')
    expect(out).toContain('content: counter(mk-h1) ".";')
    expect(out).toContain('content: counter(mk-h1) "." counter(mk-h2) ".";')
    expect(out).toContain('content: counter(mk-toc1) "." counter(mk-toc2) ".";')
  })

  test('ieee: I. / A. / 1) / a), each level its own number only', () => {
    const out = numbered('ieee')
    expect(out).toContain('content: counter(mk-h1, upper-roman) ".";')
    expect(out).toContain('content: counter(mk-h2, upper-alpha) ".";')
    expect(out).toContain('content: counter(mk-h3, decimal) ")";')
    expect(out).toContain('content: counter(mk-h4, lower-alpha) ")";')
    expect(out).toContain('content: counter(mk-toc2, upper-alpha) ".";')
    expect(out).toContain('margin-right: 0.5em;')
  })

  test('documents without h1 count from the highest numbered level (no 0.1)', () => {
    const out = numbered('decimal')
    expect(out).toContain('.paged-doc h2.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2); }')
    expect(out).toContain('.paged-doc h3.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2) "." counter(mk-h3); }')
    expect(out).toContain('.paged-doc h4.markoto-num-from-h3:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h3) "." counter(mk-h4); }')
    const ieee = numbered('ieee')
    expect(ieee).toContain('.paged-doc h2.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2, upper-roman) "."; }')
    expect(ieee).toContain('.paged-doc h3.markoto-num-from-h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h3, upper-alpha) "."; }')
  })

  test('none emits no numbering rules', () => {
    expect(numbered('none')).not.toContain('mk-h1')
  })
})

describe('per-level alignment', () => {
  test('center centres that level only', () => {
    const out = css(theme((t) => {
      t.headings.levels = { h1: { align: 'center' } }
    }))
    expect(out).toMatch(/\.paged-doc h1 \{[^}]*text-align: center;/)
    expect(out).not.toMatch(/\.paged-doc h2 \{[^}]*text-align: center;/)
    expect(resolveHeadingLevel(theme(), 1).align).toBe('left')
  })
})

describe('per-side page margins', () => {
  test('one value while the sides agree, four when they differ', () => {
    expect(css(theme())).toContain('margin: 24mm;')
    const t = theme((p) => {
      p.page.marginTop = 18
      p.page.marginBottom = 24.3
      p.page.marginLeft = 16.93
      p.page.marginRight = 16.93
    })
    expect(css(t)).toContain('margin: 18mm 16.93mm 24.3mm 16.93mm;')
  })

  test('the running rule sits relative to its own edge', () => {
    const t = theme((p) => {
      p.page.marginTop = 10
      p.page.marginBottom = 40
      p.header.left = 'H'
      p.header.rule = true
      p.footer.rule = true
    })
    const out = css(t)
    // 0.35 × margin in pt: top 10mm → 9.92pt, bottom 40mm → 39.69pt.
    expect(out).toContain('left 0 bottom 9.92pt')
    expect(out).toContain('left 0 top 39.69pt')
  })

  test('diagram widths follow the left + right margins', () => {
    const wide = theme((p) => {
      p.page.marginLeft = 10
      p.page.marginRight = 10
    })
    expect(textColumnWidthPx(wide)).toBeGreaterThan(textColumnWidthPx(theme()))
  })
})

describe('captions', () => {
  test('table captions above by default, below on request', () => {
    expect(css(theme())).toMatch(/table > caption \{\n {2}caption-side: top;/)
    expect(css(theme((t) => {
      t.tables.captionPosition = 'below'
    }))).toMatch(/table > caption \{\n {2}caption-side: bottom;/)
  })

  test('numbered labels in the document language', () => {
    const t = theme((p) => {
      p.tables.captionLabel = true
      p.blocks.figureLabel = true
    })
    const de = css(t, { ...runtime, captionLabels: captionLabelsFor('de') })
    expect(de).toContain('.paged-doc table > caption { counter-increment: mk-table; }')
    expect(de).toContain('content: "Tabelle " counter(mk-table) ": ";')
    expect(de).toContain('.paged-doc figcaption:not(:empty) { counter-increment: mk-figure; }')
    expect(de).toContain('content: "Abbildung " counter(mk-figure) ": ";')
    expect(css(t)).toContain('content: "Table " counter(mk-table) ": ";')
  })

  test('caption labels per language', () => {
    expect(captionLabelsFor('en-US')).toEqual({ table: 'Table', figure: 'Figure', separator: ': ' })
    expect(captionLabelsFor('fr')).toEqual({ table: 'Tableau', figure: 'Figure', separator: ' : ' })
    expect(captionLabelsFor('ja').table).toBe('表')
    expect(captionLabelsFor('xx').figure).toBe('Figure')
  })
})

describe('reference list', () => {
  test('hanging indents paragraphs and bullet entries', () => {
    const out = css(theme((t) => {
      t.blocks.referenceStyle = 'hanging'
    }))
    expect(out).toContain('.paged-doc p.markoto-references { padding-left: var(--doc-reference-indent, 1.5em);')
    expect(out).toContain('.paged-doc ul.markoto-references { list-style: none;')
    expect(out).not.toContain('ol.markoto-references')
  })

  test('brackets labels numbered entries [1]', () => {
    const out = css(theme((t) => {
      t.blocks.referenceStyle = 'brackets'
    }))
    expect(out).toContain('.paged-doc ol.markoto-references > li::marker { content: "[" counter(list-item) "]\\2002";')
  })
})

describe('{section} running head', () => {
  test('the token reads the section string, set only when a slot uses it', () => {
    expect(css(theme())).not.toContain('string-set')
    const out = css(theme((t) => {
      t.header.right = 'Chapter: {section}'
    }))
    expect(out).toContain('content: "Chapter: " string(mk-section);')
    expect(out).toContain('.paged-doc .markoto-section-heading { string-set: mk-section content(text); }')
  })
})

describe('template-CSS variables', () => {
  test('fonts + accent on .paged-doc and on every page (margin boxes)', () => {
    const t = theme((p) => {
      p.code.font = 'IBM Plex Mono'
    })
    const out = css(t)
    expect(out.match(/--doc-heading-font: Fraunces, /g)).toHaveLength(2)
    expect(out).toContain('--doc-body-font: Inter, ')
    expect(out).toContain('--doc-meta-font: "JetBrains Mono", ')
    expect(out).toContain('--doc-mono-font: "IBM Plex Mono", ui-monospace')
    expect(out).toContain(`--doc-accent: ${t.color.brand};`)
    delete t.code.font
    expect(css(t)).toContain('--doc-mono-font: ui-monospace, ')
  })
})

describe('first section + cover title', () => {
  test('multi-column themes span only the first section, not the first h1 of every page', () => {
    const out = css(theme((t) => {
      t.cover.enabled = false
      t.layout.columns = 2
    }))
    expect(out).toContain('.paged-doc > h1.markoto-first-section {\n  column-span: all;')
    expect(out).not.toContain('first-of-type')
    // Single-column: no spanner (it only changed the margins there).
    expect(css(theme((t) => {
      t.cover.enabled = false
    }))).not.toContain('markoto-first-section')
  })

  test('the cover and title-block titles are balanced', () => {
    expect(css(theme())).toMatch(/\.markoto-cover-title \{[^}]*text-wrap: balance;/)
    const tb = css(theme((t) => {
      t.cover.layout = 'title-block'
    }))
    expect(tb).toMatch(/\.markoto-title-block \.markoto-cover-title \{[^}]*text-wrap: balance;/)
  })
})

describe('number + unit in table cells', () => {
  const kept = (s: string) => nowrapRuns(s).filter(r => r.nowrap).map(r => r.text)

  test('keeps number + unit, currency + amount, comparison + number, short codes', () => {
    expect(kept('+8.1 %')).toEqual(['+8.1 %'])
    expect(kept('54.8 % of 52.7 %')).toEqual(['54.8 %', '52.7 %'])
    expect(kept('p99 latency > 3 s')).toEqual(['> 3 s'])
    expect(kept('CHF 48.6 million')).toEqual(['CHF 48.6'])
    expect(kept('Page IC within 15 min')).toEqual(['15 min'])
    expect(kept('SEV-1 and ISO-8601')).toEqual(['SEV-1', 'ISO-8601'])
    expect(kept('−9.2 %')).toEqual(['−9.2 %'])
  })

  test('leaves words, lone numbers and long text alone', () => {
    expect(kept('48.6')).toEqual([])
    expect(kept('Customers cannot complete payments')).toEqual([])
    expect(kept('2 and 3 apples')).toEqual([])
    expect(kept('re-run the job')).toEqual([])
    expect(nowrapRuns('a 5 % b').map(r => r.text).join('')).toBe('a 5 % b')
  })
})
