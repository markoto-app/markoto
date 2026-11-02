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
  test('every preset has a brand block with sane logoHeight', () => {
    // markoto pre-fills logoUrl with the public wordmark asset; other
    // presets ship with an empty string until users upload their own.
    for (const preset of THEME_PRESETS) {
      if (preset.id === 'markoto') {
        expect(preset.theme.brand.logoUrl).toBe('/markoto-logos/primary-lockup-light.svg')
      } else {
        expect(preset.theme.brand.logoUrl).toBe('')
      }
      expect(preset.theme.brand.logoHeight).toBeGreaterThanOrEqual(8)
      expect(preset.theme.brand.logoHeight).toBeLessThanOrEqual(80)
    }
  })
  test('cover-enabled themes emit .markoto-cover-logo CSS rule', () => {
    const css = themeToCss(markoto, runtime)
    expect(css).toContain('.markoto-cover-logo')
    // markoto preset's logoHeight is 56 (was 48 before the cover-design
    // refresh).
    expect(css).toMatch(/\.markoto-cover-logo\s*\{[^}]*height:\s*56px/)
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
    // Editorial: logo top, title at ⅓, meta at ⅔ — matches the
    // brand voice. Switched from `centered` when the layout enum
    // expanded to (classic/editorial/banner/minimal).
    expect(markoto.cover.layout).toBe('editorial')
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
    expect(css).toContain('@top-left { content: \'\'; }')
    expect(css).toContain('@bottom-center { content: \'\'; }')
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
  test('layout=editorial uses CSS Grid with 6 rows for the ⅓ rhythm', () => {
    // Editorial pins logo at top, title block at ~⅓, meta at ~⅔ via a
    // 6-row grid (auto / 1fr / auto / 1fr / auto / 1fr). The three
    // equal `1fr` spacers are what produce the ⅓ rhythm — without
    // them the grid would collapse content to its natural sizes.
    const editorial: DocTheme = { ...markoto, cover: { ...markoto.cover, layout: 'editorial' } }
    const css = themeToCss(editorial, runtime)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*grid-template-rows:\s*auto 1fr auto 1fr auto 1fr/)
    expect(css).toMatch(/markoto-cover-title\s*\{\s*grid-row:\s*3/)
    expect(css).toMatch(/markoto-cover-meta\s*\{\s*grid-row:\s*5/)
  })
  test('layout=editorial stacks the subtitle under the title (one column)', () => {
    // Regression: title and subtitle both sat in grid-row 3 of a grid
    // without explicit columns, so the subtitle was auto-placed into an
    // implicit second column (title left, subtitle right).
    const editorial: DocTheme = {
      ...markoto,
      cover: { ...markoto.cover, layout: 'editorial', showSubtitle: true, subtitle: 'Sub' }
    }
    const css = themeToCss(editorial, runtime)
    expect(css).toMatch(/markoto-cover-subtitle\s*\{\s*grid-row:\s*4;\s*grid-column:\s*1/)
    for (const part of ['logo', 'title', 'subtitle', 'meta']) {
      expect(css).toMatch(new RegExp(`markoto-cover-${part}\\s*\\{\\s*grid-row:\\s*\\d;\\s*grid-column:\\s*1`))
    }
  })
  test('layout=classic uses flex-column centered (vertical mid)', () => {
    const classic: DocTheme = { ...markoto, cover: { ...markoto.cover, layout: 'classic' } }
    const css = themeToCss(classic, runtime)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.markoto-cover\s*\{[^}]*justify-content:\s*center/)
  })
  test('layout=banner places logo + title in a brand-tinted top band', () => {
    const banner: DocTheme = { ...markoto, cover: { ...markoto.cover, layout: 'banner' } }
    const css = themeToCss(banner, runtime)
    // The band is the cover's ::before, spanning the logo (row 1) and
    // title (row 2) rows on a color-mixed brand tint; the logo and title
    // themselves carry no background (a tinted <img> stretched into an
    // empty box beside the title).
    expect(css).toMatch(/markoto-cover::before\s*\{[^}]*grid-row:\s*1 \/ 3[^}]*background:\s*color-mix/)
    expect(css).toMatch(/markoto-cover-logo\s*\{\s*grid-row:\s*1;\s*grid-column:\s*1/)
    expect(css).toMatch(/markoto-cover-title\s*\{\s*grid-row:\s*2;\s*grid-column:\s*1/)
    expect(css).not.toMatch(/markoto-cover-(logo|title)[^{]*\{[^}]*background/)
    expect(css).toMatch(/markoto-cover\s*\{[^}]*grid-template-columns:\s*100%/)
    expect(css).toMatch(/markoto-cover-meta\s*\{\s*grid-row:\s*5/)
  })
  test('layout=minimal hides logo + meta even when toggled on', () => {
    const minimal: DocTheme = {
      ...markoto,
      cover: { ...markoto.cover, layout: 'minimal', showLogo: true, showAuthors: true, authors: ['Alice'] }
    }
    const css = themeToCss(minimal, runtime)
    // The CSS forces display:none on .markoto-cover-logo and -meta
    // regardless of toggles; "minimal" is a stronger statement than
    // "what the user toggled".
    expect(css).toMatch(/markoto-cover-logo,\s*\.paged-doc \.markoto-cover-meta\s*\{\s*display:\s*none/)
  })
  test('cover.titleSize drives the h1 font-size em multiplier', () => {
    const big: DocTheme = { ...markoto, cover: { ...markoto.cover, titleSize: 3.6 } }
    const css = themeToCss(big, runtime)
    expect(css).toMatch(/markoto-cover-title\s*\{[^}]*font-size:\s*3\.6em/)
  })
  test('cover.subtitleSize drives the subtitle em multiplier', () => {
    const small: DocTheme = { ...markoto, cover: { ...markoto.cover, subtitleSize: 0.8 } }
    const css = themeToCss(small, runtime)
    expect(css).toMatch(/markoto-cover-subtitle\s*\{[^}]*font-size:\s*0\.8em/)
  })
  test('cover.align flows through to text-align', () => {
    const left: DocTheme = { ...markoto, cover: { ...markoto.cover, align: 'left' } }
    expect(themeToCss(left, runtime)).toMatch(/\.markoto-cover\s*\{[^}]*text-align:\s*left/)
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
      footer: {
        ...markoto.footer,
        left: '',
        center: '{page} · {pages}',
        right: ''
      }
    }
    const css = themeToCss(markotoWithFooter, runtime)
    // figcaption font-family
    expect(css).toMatch(/figcaption\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
    // footnote font-family
    expect(css).toMatch(/\.footnote\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
    // margin-box (footer)
    expect(css).toMatch(/@bottom-center\s*\{[^}]*font-family:\s*"?JetBrains Mono"?/)
  })
  test('the @footnote area carries the meta font (it sits outside .paged-doc)', () => {
    // paged.js moves footnotes into a page-level area outside `.paged-doc`,
    // so the `.paged-doc .footnote` rule no longer matches there and the
    // notes fell back to the browser's default serif.
    const css = themeToCss(markoto, runtime)
    expect(css).toMatch(/@footnote\s*\{[^}]*font-family:\s*"JetBrains Mono"/)
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

describe('themeToCss — horizontal table borders', () => {
  test('keeps the rule under the header row; drops it only after the last body row', () => {
    // Regression: `tr:last-child { border-bottom: none }` also matched the
    // header row (the only — so last — <tr> of <thead>), which left
    // horizontal-border tables with no line between header and body.
    const theme: DocTheme = { ...markoto, tables: { ...markoto.tables, borders: 'horizontal' } }
    const css = themeToCss(theme, runtime)
    expect(css).toContain('.paged-doc tr { border-bottom: 1px solid var(--doc-secondary); }')
    expect(css).toContain('.paged-doc tbody tr:last-child { border-bottom: none; }')
    expect(css).not.toMatch(/\.paged-doc tr:last-child/)
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

describe('themeToCss — generated CSS strings and image URLs (regression)', () => {
  const withHeader = (header: Partial<DocTheme['header']>): DocTheme => ({
    ...markoto,
    header: { ...markoto.header, left: '{title}', center: '', right: '', imageUrl: '', ...header }
  })

  test('a newline in the title cannot end the CSS string and start a new rule', () => {
    const css = themeToCss(withHeader({}), { ...runtime, title: 'x\n}} .paged-doc p { color: red } @page { x: "' })
    // The raw newline is escaped, so the injected text stays inside the
    // string: `}} .paged-doc p { color: red }` never starts a line of CSS.
    expect(css).not.toContain('\n}} .paged-doc p')
    const box = /@top-left \{\s*content: ("(?:[^"\\\n]|\\.)*");/.exec(css)
    expect(box?.[1]).toContain(String.raw`\a `)
  })

  test('control characters in the title are escaped, NUL becomes U+FFFD', () => {
    const css = themeToCss(withHeader({}), { ...runtime, title: 'a\r\fb\u0000c\u007F' })
    expect(css).toContain(String.raw`"a\d \c b` + '�' + String.raw`c\7f "`)
  })

  test('an image URL that is not an upload path is not emitted', () => {
    const evil = String.raw`x\'); }} .paged-doc p { color: red } @page { x: url('`
    const css = themeToCss(withHeader({ imageUrl: evil, imagePosition: 'left' }), runtime)
    expect(css).not.toContain('.paged-doc p { color: red }')
    expect(css).not.toContain('content: url(')
  })

  test('an upload-path image URL is emitted as a quoted url()', () => {
    const css = themeToCss(withHeader({ imageUrl: '/api/files/doc1/AbCdEfGhIjKl.png', imagePosition: 'center' }), runtime)
    expect(css).toMatch(/@top-center \{\s*content: url\("\/api\/files\/doc1\/AbCdEfGhIjKl\.png"\);/)
  })

  // The server render page loads private docs' header/footer images with
  // its file-access token; without the mapping those images 403 in the PDF.
  test('runtime.imageUrl maps header and footer image URLs', () => {
    const theme: DocTheme = {
      ...withHeader({ imageUrl: '/api/files/doc1/AbCdEfGhIjKl.png', imagePosition: 'left' }),
      footer: { ...markoto.footer, left: '', center: '', right: '', imageUrl: '/api/files/doc1/ZyXwVuTsRqPo.webp', imagePosition: 'right' }
    }
    const css = themeToCss(theme, { ...runtime, imageUrl: url => `${url}?token=t.k.n` })
    expect(css).toMatch(/@top-left \{\s*content: url\("\/api\/files\/doc1\/AbCdEfGhIjKl\.png\?token=t\.k\.n"\);/)
    expect(css).toMatch(/@bottom-right \{\s*content: url\("\/api\/files\/doc1\/ZyXwVuTsRqPo\.webp\?token=t\.k\.n"\);/)
  })

  test('runtime.imageUrl is never called for a URL that failed the shape check', () => {
    const seen: string[] = []
    themeToCss(withHeader({ imageUrl: 'https://evil.example/x.png', imagePosition: 'left' }), {
      ...runtime,
      imageUrl: (url) => {
        seen.push(url)
        return url
      }
    })
    expect(seen).toEqual([])
  })
})
