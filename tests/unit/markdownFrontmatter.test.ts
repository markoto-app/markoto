import { describe, expect, test } from 'vitest'
import {
  FRONTMATTER_MAX_BYTES,
  MARKOTO_FRONTMATTER_VERSION,
  buildMarkdownExport,
  splitMarkotoFrontmatter
} from '../../shared/utils/markdownFrontmatter'
import { importMarkdownFile } from '../../server/utils/markdownImport'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import type { DocTheme } from '../../shared/types/theme'

const BODY = '# Title\n\nA paragraph.\n\n```yaml\n---\nnot: frontmatter\n---\n```\n'
const PROPS = {
  title: 'Q3: "plan" & notes',
  description: 'Line one: with a colon',
  audience: 'business',
  language: 'Schwiizerdütsch',
  templateId: 'blank',
  theme: { ...structuredClone(defaultTheme), customCss: '.paged-doc h2 {\n  color: var(--doc-brand);\n}\n' }
}

describe('buildMarkdownExport / splitMarkotoFrontmatter', () => {
  test('round trip: same body, same properties, versioned', () => {
    const file = buildMarkdownExport(BODY, PROPS)
    expect(file.startsWith(`---\nmarkoto: ${MARKOTO_FRONTMATTER_VERSION}\n`)).toBe(true)
    const split = splitMarkotoFrontmatter(file)
    expect(split.kind).toBe('markoto')
    if (split.kind !== 'markoto') return
    expect(split.body).toBe(BODY)
    expect(split.data).toMatchObject({ title: PROPS.title, description: PROPS.description, audience: 'business', language: PROPS.language, templateId: 'blank' })
    expect(split.data.theme).toEqual(PROPS.theme)
  })

  test('custom CSS is a readable block scalar', () => {
    const file = buildMarkdownExport(BODY, PROPS)
    expect(file).toContain('customCss: |')
    expect(file).toContain('    .paged-doc h2 {')
  })

  test('no frontmatter → none; foreign or broken frontmatter → foreign', () => {
    expect(splitMarkotoFrontmatter(BODY)).toEqual({ kind: 'none' })
    expect(splitMarkotoFrontmatter('---\nlayout: post\ntitle: Hi\n---\nbody')).toEqual({ kind: 'foreign' })
    expect(splitMarkotoFrontmatter('---\nmarkoto: 2\ntitle: Future\n---\nbody')).toEqual({ kind: 'foreign' })
    expect(splitMarkotoFrontmatter('---\nmarkoto: "1"\n---\nbody')).toEqual({ kind: 'foreign' })
    expect(splitMarkotoFrontmatter('---\nmarkoto: 1\ntitle: [unclosed\n---\nbody')).toEqual({ kind: 'foreign' })
    expect(splitMarkotoFrontmatter('---\n- a list\n---\nbody')).toEqual({ kind: 'foreign' })
    // A horizontal rule at the top with no closing fence is just text.
    expect(splitMarkotoFrontmatter('---\nNot frontmatter at all')).toEqual({ kind: 'none' })
  })

  test('refuses aliases, duplicate keys and custom tags', () => {
    expect(splitMarkotoFrontmatter('---\nmarkoto: 1\na: &x [1, 2]\nb: *x\n---\n').kind).toBe('foreign')
    expect(splitMarkotoFrontmatter('---\nmarkoto: 1\ntitle: a\ntitle: b\n---\n').kind).toBe('foreign')
    expect(splitMarkotoFrontmatter('---\nmarkoto: 1\ntitle: !!js/function "x"\n---\n').kind).toBe('foreign')
  })

  test('accepts CRLF line endings and a BOM', () => {
    const file = '﻿' + buildMarkdownExport(BODY, PROPS).replaceAll('\n', '\r\n')
    const split = splitMarkotoFrontmatter(file)
    expect(split.kind).toBe('markoto')
    if (split.kind === 'markoto') expect(split.data.title).toBe(PROPS.title)
  })

  test('oversized frontmatter is not read', () => {
    const huge = `---\nmarkoto: 1\ntitle: x\nfill: "${'a'.repeat(FRONTMATTER_MAX_BYTES + 10)}"\n---\nbody`
    expect(splitMarkotoFrontmatter(huge).kind).toBe('foreign')
  })
})

describe('importMarkdownFile (server-side validation)', () => {
  const opts = { docId: 'docB', allowedOrigins: ['https://markoto.example'] }

  test('plain and foreign files are returned unchanged', () => {
    expect(importMarkdownFile(BODY, opts)).toEqual({ markdown: BODY })
    const jekyll = '---\nlayout: post\n---\n\nHi'
    expect(importMarkdownFile(jekyll, opts)).toEqual({ markdown: jekyll })
  })

  test('valid properties come back; invalid ones are listed, unknown keys dropped', () => {
    const file = buildMarkdownExport(BODY, PROPS).replace('markoto: 1\n', 'markoto: 1\nisAdmin: true\n')
    const res = importMarkdownFile(file, opts)
    expect(res.markdown).toBe(BODY)
    expect(res.properties).toEqual(PROPS)
    expect(res.ignored).toBeUndefined()

    const bad = buildMarkdownExport(BODY, { ...PROPS, title: 'x'.repeat(256), audience: 'overlords', language: '', templateId: 'nope' })
    const badRes = importMarkdownFile(bad, opts)
    expect(badRes.ignored).toEqual(['title', 'audience', 'language', 'templateId'])
    expect(badRes.properties).toEqual({ description: PROPS.description, theme: PROPS.theme })
  })

  test('a partial (older) theme is filled from the defaults; an invalid one is ignored', () => {
    const partial = '---\nmarkoto: 1\ntheme:\n  body:\n    font: Lora\n---\nx'
    const res = importMarkdownFile(partial, opts)
    expect(res.properties?.theme?.body.font).toBe('Lora')
    expect(res.properties?.theme?.page).toEqual(defaultTheme.page)

    const invalid = '---\nmarkoto: 1\ntheme:\n  body:\n    color: "red; } body { display: none"\n---\nx'
    expect(importMarkdownFile(invalid, opts).ignored).toEqual(['theme'])
    const extraKey = '---\nmarkoto: 1\ntheme:\n  evil: 1\n---\nx'
    expect(importMarkdownFile(extraKey, opts).ignored).toEqual(['theme'])
  })

  test('another document\'s images are removed from the theme and the custom CSS', () => {
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')!.theme
    const theme: DocTheme = {
      ...arxiv,
      brand: { ...arxiv.brand, logoUrl: '/api/files/docA/abcdefghijkl.png' },
      customCss: '.paged-doc h2 { color: var(--doc-brand) }\n.paged-doc .hero { background: url(/api/files/docA/abcdefghijkl.png) }\n'
    }
    const file = buildMarkdownExport(BODY, { ...PROPS, theme })
    const res = importMarkdownFile(file, opts)
    expect(res.properties?.theme?.brand.logoUrl).toBe('')
    expect(res.properties?.theme?.customCss).toContain('color')
    expect(res.properties?.theme?.customCss).not.toContain('docA')
    expect(res.droppedCustomCssRules).toBe(1)

    // The same file into its own document keeps everything.
    const own = importMarkdownFile(file, { ...opts, docId: 'docA' })
    expect(own.properties?.theme).toEqual(theme)
    expect(own.droppedCustomCssRules).toBeUndefined()
  })

  test('disallowed custom CSS never passes: @import and external URLs are removed', () => {
    const theme = { ...structuredClone(defaultTheme), customCss: '@import url(https://evil.example/a.css);\n.paged-doc p { color: red }\n.paged-doc .x { background: url(https://evil.example/t.png) }\n' }
    const res = importMarkdownFile(buildMarkdownExport(BODY, { ...PROPS, theme }), opts)
    const css = res.properties?.theme?.customCss ?? ''
    expect(css).toContain('color:red')
    expect(css).not.toContain('evil')
    expect(css).not.toContain('@import')
  })
})
