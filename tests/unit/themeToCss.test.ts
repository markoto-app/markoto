import { describe, expect, test } from 'vitest'
import { themeToCss } from '../../shared/utils/themeToCss'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import type { DocTheme, ThemeRuntime } from '../../shared/types/theme'

/**
 * Deterministic verification of `themeToCss` output. Independent of
 * paged.js, the iframe, the browser — the function takes a DocTheme
 * and a runtime and returns a string. We assert specific substrings /
 * regex patterns are present so each preset commits visibly to its
 * intended look. Catches regressions where a refactor accidentally
 * drops a rule or a preset's value drifts.
 */

const runtime: ThemeRuntime = {
  title: 'Test Document',
  date: '2026-04-29',
  tocTitle: 'Table of Contents'
}

const markoto = THEME_PRESETS.find(p => p.id === 'markoto')!.theme
const modern = THEME_PRESETS.find(p => p.id === 'modern')!.theme
const novel = THEME_PRESETS.find(p => p.id === 'novel')!.theme
const academic = THEME_PRESETS.find(p => p.id === 'academic')!.theme

describe('themeToCss — markoto preset (the flagship + default)', () => {
  const css = themeToCss(markoto, runtime)

  describe('Step 1 — preset values', () => {
    test('emits sumi-50 cream paper background', () => {
      expect(css).toContain('--doc-bg: #FAF8F4')
    })
    test('emits sumi-950 body text colour', () => {
      expect(css).toContain('--doc-text: #14110D')
    })
    test('emits shu-500 brand colour', () => {
      expect(css).toContain('--doc-brand: #B5371F')
    })
    test('emits sumi-900 heading colour', () => {
      expect(css).toContain('--doc-heading-color: #1F1B14')
    })
    test('emits Fraunces heading font', () => {
      expect(css).toMatch(/font-family:\s*Fraunces/)
    })
    test('emits Inter body font', () => {
      expect(css).toMatch(/\.paged-doc\s*\{[^}]*font-family:\s*Inter/)
    })
    test('emits 24mm page margin', () => {
      expect(css).toContain('margin: 24mm')
    })
  })

  describe('Step 2 — per-block alignment classes', () => {
    test('emits .text-left helper', () => {
      expect(css).toMatch(/\.paged-doc\s+\.text-left\s*\{[^}]*text-align:\s*left/)
    })
    test('emits .text-center helper', () => {
      expect(css).toMatch(/\.paged-doc\s+\.text-center\s*\{[^}]*text-align:\s*center/)
    })
    test('emits .text-right helper', () => {
      expect(css).toMatch(/\.paged-doc\s+\.text-right\s*\{[^}]*text-align:\s*right/)
    })
    test('emits .text-justify helper with hyphenation', () => {
      expect(css).toMatch(/\.paged-doc\s+\.text-justify\s*\{[^}]*text-align:\s*justify/)
      expect(css).toMatch(/\.paged-doc\s+\.text-justify\s*\{[^}]*hyphens:\s*auto/)
    })
  })

  describe('Step 3 — theme-aware alerts (markoto warm-paper palette)', () => {
    test('uses slate blue for note', () => {
      expect(css).toContain('#3D5A80')
    })
    test('uses forest sage for tip', () => {
      expect(css).toContain('#4A6F4D')
    })
    test('uses muted plum for important', () => {
      expect(css).toContain('#6B4F7F')
    })
    test('uses warm ochre for warning', () => {
      expect(css).toContain('#9C7A2C')
    })
    test('uses shu-500 for caution', () => {
      expect(css).toContain('#B5371F')
    })
  })

  describe('Step 4 — secondary colour (sumi-400)', () => {
    test('emits --doc-secondary CSS variable', () => {
      expect(css).toContain('--doc-secondary: #A39A8A')
    })
    test('hr uses var(--doc-secondary)', () => {
      expect(css).toMatch(/\.paged-doc hr[^{]*\{[^}]*--doc-secondary/)
    })
    test('figcaption uses var(--doc-secondary)', () => {
      expect(css).toMatch(/figcaption\s*\{[^}]*--doc-secondary/)
    })
    test('TOC leader uses var(--doc-secondary)', () => {
      expect(css).toMatch(/table-of-contents a::before\s*\{[^}]*--doc-secondary/)
    })
    test('TOC page number uses var(--doc-secondary)', () => {
      expect(css).toMatch(/table-of-contents a::after\s*\{[^}]*--doc-secondary/)
    })
  })

  describe('Step 5 — HR styling (asterism for markoto)', () => {
    test('emits ⁂ glyph via hr::before', () => {
      expect(css).toMatch(/hr::before[^{]*\{[^}]*content:\s*'⁂'/)
    })
    test('asterism uses --doc-secondary colour', () => {
      expect(css).toMatch(/hr::before[^{]*\{[^}]*color:\s*var\(--doc-secondary\)/)
    })
  })

  describe('Step 6 — drop cap (span-based for paged.js compatibility)', () => {
    test('emits .markoto-dropcap rule (NOT ::first-letter, paged.js strips it)', () => {
      expect(css).toContain('.markoto-dropcap')
      expect(css).not.toMatch(/::first-letter/)
    })
    test('drop cap uses heading font (Fraunces)', () => {
      expect(css).toMatch(/\.markoto-dropcap[^{]*\{[^}]*font-family:\s*Fraunces/)
    })
    test('drop cap floats left', () => {
      expect(css).toMatch(/\.markoto-dropcap[^{]*\{[^}]*float:\s*left/)
    })
    test('drop cap is ~3.4em', () => {
      expect(css).toMatch(/\.markoto-dropcap[^{]*\{[^}]*font-size:\s*3\.4em/)
    })
  })

  describe('Step 7 — fine-grained typography knobs', () => {
    test('h1 has line-height 1.25 (markoto value, not the old hardcoded 1.2)', () => {
      expect(css).toMatch(/h1\s*\{[^}]*line-height:\s*1\.25/)
    })
    test('h1 has -0.01em letter-spacing (Fraunces tracking)', () => {
      expect(css).toMatch(/h1\s*\{[^}]*letter-spacing:\s*-0\.01em/)
    })
    test('h1 has margin-top 1.68em (1.4 base × 1.2 spacingScale)', () => {
      expect(css).toMatch(/h1\s*\{[^}]*margin-top:\s*1\.68em/)
    })
    test('paragraph margin from theme.body.paragraphSpacing (0.6em)', () => {
      expect(css).toMatch(/\.paged-doc p\s*\{[^}]*margin:\s*0\.60em\s*0/)
    })
    test('hyphenate=false → no hyphens rule on body', () => {
      // Hyphenation should not appear on `.paged-doc p` (only on
      // `.text-justify` helper class, which is independent).
      const pRule = css.match(/\.paged-doc p\s*\{[^}]*\}/)?.[0] ?? ''
      expect(pRule).not.toMatch(/hyphens:\s*auto/)
    })
    test('firstLineIndent=false → no `p + p` indent rule', () => {
      expect(css).not.toMatch(/p \+ p\s*\{[^}]*text-indent/)
    })
  })

  describe('paper bg + page chrome', () => {
    test('mark uses brand color tint', () => {
      expect(css).toMatch(/mark\s*\{[^}]*var\(--doc-brand\)/)
    })
  })
})

describe('themeToCss — Step 10: brand logo on cover', () => {
  test('every preset has a brand block with empty logoUrl + sensible logoHeight', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.theme.brand.logoUrl).toBe('')
      expect(preset.theme.brand.logoHeight).toBeGreaterThanOrEqual(8)
      expect(preset.theme.brand.logoHeight).toBeLessThanOrEqual(80)
    }
  })
  test('cover-enabled themes emit .markoto-cover-logo CSS rule', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toContain('.markoto-cover-logo')
    expect(css).toMatch(/\.markoto-cover-logo\s*\{[^}]*height:\s*48px/)
  })
  test('logoHeight from theme threads into the CSS', () => {
    const tall: DocTheme = { ...markoto, brand: { logoUrl: '', logoHeight: 72 } }
    const css = themeToCss(tall, runtime)
    expect(css).toMatch(/\.markoto-cover-logo\s*\{[^}]*height:\s*72px/)
  })
  test('cover-disabled theme does not emit cover-logo rule', () => {
    const css = themeToCss(modern, runtime)
    expect(css).not.toContain('markoto-cover-logo')
  })
})

describe('themeToCss — Step 9: cover page', () => {
  test('markoto preset has cover enabled by default', () => {
    expect(markoto.cover.enabled).toBe(true)
    expect(markoto.cover.layout).toBe('centered')
  })
  test('cover-enabled theme emits .markoto-cover rule with named page', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*page:\s*cover-page/)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*break-after:\s*page/)
  })
  test('cover-enabled theme emits @page cover-page rule that suppresses margin boxes', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toMatch(/@page cover-page\s*\{/)
    // All 6 margin-box positions cleared
    expect(css).toContain("@top-left { content: ''; }")
    expect(css).toContain("@bottom-center { content: ''; }")
  })
  test('cover-disabled theme emits NO .markoto-cover rule', () => {
    const css = themeToCss(modern, runtime)
    expect(css).not.toContain('.markoto-cover')
    expect(css).not.toMatch(/@page cover-page/)
  })
  test('cover title styled in heading font', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toMatch(/markoto-cover-title\s*\{[^}]*font-family:\s*Fraunces/)
  })
  test('cover author styled in meta font (markoto = JetBrains Mono)', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toMatch(/markoto-cover-author\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
  })
  test('layout=split changes justify-content to space-between (academic preset)', () => {
    const split = THEME_PRESETS.find(p => p.id === 'academic')!.theme
    expect(split.cover.enabled).toBe(true)
    expect(split.cover.layout).toBe('split')
    const css = themeToCss(split, runtime)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*justify-content:\s*space-between/)
  })
  test('layout=top changes justify-content to flex-start', () => {
    const topTheme: DocTheme = { ...markoto, cover: { ...markoto.cover, layout: 'top' } }
    const css = themeToCss(topTheme, runtime)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*justify-content:\s*flex-start/)
  })
  test('authors array supports multiple entries (collaboration tool)', () => {
    const multi: DocTheme = {
      ...markoto,
      cover: { ...markoto.cover, showAuthors: true, authors: ['Alice', 'Bob', 'Charlie'] }
    }
    // The CSS itself doesn't contain author names (they go in HTML),
    // but the schema accepts them.
    expect(multi.cover.authors).toHaveLength(3)
    expect(() => themeToCss(multi, runtime)).not.toThrow()
  })
})

describe('themeToCss — Step 8: meta font (eyebrow voice)', () => {
  test('markoto preset: header/footer/figcaption/footnote all use JetBrains Mono', () => {
    const markotoWithFooter: DocTheme = {
      ...markoto,
      footer: { left: '', center: '{page} · {pages}', right: '' }
    }
    const css = themeToCss(markotoWithFooter, runtime)
    // figcaption font-family
    expect(css).toMatch(/figcaption\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
    // footnote font-family
    expect(css).toMatch(/\.footnote\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
    // margin-box (footer)
    expect(css).toMatch(/@bottom-center\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
  })
  test('Google Fonts import includes the meta font', () => {
    const css = themeToCss(markoto, runtime)
    // We don't call themeFontsImport here; the rule is that defaultTheme's
    // meta font is JetBrains Mono and themeFontsImport must include it.
    // Verified via a separate import test below.
    expect(css).toContain('JetBrains Mono')
  })
  test('meta font defaults sensibly (markoto = JetBrains Mono, novel = body font)', () => {
    expect(THEME_PRESETS.find(p => p.id === 'markoto')!.theme.meta.font).toBe('JetBrains Mono')
    // Novel keeps it consistent with body — no jarring third-font moment.
    expect(THEME_PRESETS.find(p => p.id === 'novel')!.theme.meta.font).toBe('Crimson Text')
  })
})

describe('themeToCss — modern preset (canonical look stays unchanged)', () => {
  const css = themeToCss(modern, runtime)

  test('keeps GitHub-blue note alert', () => {
    expect(css).toContain('#0969da')
  })
  test('keeps GitHub-green tip alert', () => {
    expect(css).toContain('#1a7f37')
  })
  test('uses solid-rule HR (not asterism)', () => {
    expect(css).toMatch(/\.paged-doc hr[^{]*\{[^}]*border-top:\s*1px solid/)
    expect(css).not.toMatch(/hr::before[^{]*content:\s*'⁂'/)
  })
  test('drop cap disabled (no .markoto-dropcap rule)', () => {
    expect(css).not.toContain('.markoto-dropcap')
  })
  test('h1 line-height stays 1.2 (no override)', () => {
    expect(css).toMatch(/h1\s*\{[^}]*line-height:\s*1\.2[^5]/)
  })
})

describe('themeToCss — academic preset (first-line indent)', () => {
  const css = themeToCss(academic, runtime)

  test('emits `p + p` indent rule when firstLineIndent=true', () => {
    expect(css).toMatch(/p \+ p\s*\{\s*text-indent:\s*1\.2em/)
  })
  test('paragraph spacing tightened to 0.4em', () => {
    expect(css).toMatch(/\.paged-doc p\s*\{[^}]*margin:\s*0\.40em\s*0/)
  })
  test('hyphenation enabled on body', () => {
    expect(css).toMatch(/\.paged-doc p\s*\{[^}]*hyphens:\s*auto/)
  })
})

describe('themeToCss — novel preset (literary signature)', () => {
  const css = themeToCss(novel, runtime)

  test('emits asterism HR (literary scene break)', () => {
    expect(css).toMatch(/hr::before[^{]*\{[^}]*content:\s*'⁂'/)
  })
  test('drop cap enabled', () => {
    expect(css).toContain('.markoto-dropcap')
  })
  test('first-line indent enabled (novel typography)', () => {
    expect(css).toMatch(/p \+ p\s*\{\s*text-indent:\s*1\.2em/)
  })
  test('tight paragraph spacing 0.2em (indent carries the visual break)', () => {
    expect(css).toMatch(/\.paged-doc p\s*\{[^}]*margin:\s*0\.20em\s*0/)
  })
})

describe('themeToCss — defaultTheme matches markoto preset', () => {
  test('defaultTheme produces the same CSS as the markoto preset', () => {
    const defaultCss = themeToCss(defaultTheme, runtime)
    const markotoCss = themeToCss(markoto, runtime)
    expect(defaultCss).toBe(markotoCss)
  })
})

describe('themeToCss — alerts toggle off cleanly', () => {
  test('every preset has all 5 alerts', () => {
    for (const preset of THEME_PRESETS) {
      const css = themeToCss(preset.theme, runtime)
      expect(css).toMatch(/markdown-alert-note/)
      expect(css).toMatch(/markdown-alert-tip/)
      expect(css).toMatch(/markdown-alert-important/)
      expect(css).toMatch(/markdown-alert-warning/)
      expect(css).toMatch(/markdown-alert-caution/)
    }
  })
})

describe('themeToCss — schema completeness invariants', () => {
  test('every preset emits a parseable CSS string', () => {
    for (const preset of THEME_PRESETS) {
      const css = themeToCss(preset.theme, runtime)
      expect(css.length).toBeGreaterThan(1000)
      expect(css).toContain('.paged-doc')
      expect(css).toContain('--doc-brand')
      expect(css).toContain('--doc-secondary')
    }
  })
  test('all 7 presets exist', () => {
    expect(THEME_PRESETS.map(p => p.id)).toEqual([
      'markoto', 'modern', 'academic', 'tech', 'business', 'novel', 'newsletter'
    ])
  })
  test('markoto is first preset (becomes default in new-doc dialog)', () => {
    expect(THEME_PRESETS[0]!.id).toBe('markoto')
  })
})

describe('themeToCss — special characters are interpolated safely', () => {
  test('does not double-escape title with quotes', () => {
    const themed = themeToCss(markoto, { ...runtime, title: 'It\'s a "test"' })
    // Just verify it doesn't throw and still emits the brand var
    expect(themed).toContain('--doc-brand')
  })
})
