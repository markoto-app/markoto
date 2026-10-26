import { describe, it, expect } from 'vitest'
import {
  coerceThemePatch,
  mergeTheme,
  summarizePatch,
  parseInternalFileRef,
  lineToCharOffset,
  sanitizeAltText,
  parseDocIdFromInput,
  resolveThemeCustomCss
} from '../../server/utils/aiToolAdapter'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { UpdateThemeArgs, type UpdateThemeInput } from '../../server/utils/agentic/functionTools'

// Pure helpers that power the AI theme + image tools. Integration with
// DB / S3 is skipped here (those paths need module mocks); these are the
// bits of logic that are easy to regress without visible failure — bad
// merge, stale drift, mis-parsed file ref — so they get pinned.

describe('coerceThemePatch', () => {
  it('coerces headings.weight string enum to number', () => {
    // Function-call schema stability (carried over from pre-Phase-5
    // Gemini-era constraints) forces weight to be '600' not 600;
    // handler must un-stringify before isValidTheme (which expects a
    // number literal).
    const out = coerceThemePatch({ headings: { weight: '600' } } as UpdateThemeInput) as { headings: { weight: number } }
    expect(out.headings.weight).toBe(600)
    expect(typeof out.headings.weight).toBe('number')
  })

  it('coerces layout.columns string enum to number', () => {
    const out = coerceThemePatch({ layout: { columns: '2' } } as UpdateThemeInput) as { layout: { columns: number } }
    expect(out.layout.columns).toBe(2)
  })

  it('coerces toc.maxDepth string enum to number', () => {
    const out = coerceThemePatch({ toc: { maxDepth: '3' } } as UpdateThemeInput) as { toc: { maxDepth: number } }
    expect(out.toc.maxDepth).toBe(3)
  })

  it('strips the `preset` directive so it never lands on the DocTheme', () => {
    // `preset` is a tool-arg that selects the base theme — it must NOT
    // appear on the merged DocTheme or isValidTheme will reject it.
    const out = coerceThemePatch({ preset: 'modern' } as UpdateThemeInput)
    expect('preset' in out).toBe(false)
  })

  it('strips theme_id and from_workspace_default directives too', () => {
    // Both new base sources are directives, not theme fields. Same
    // contract as `preset` — they must not land on the merged DocTheme.
    const out = coerceThemePatch({
      theme_id: 'abc123',
      from_workspace_default: true,
      body: { size: 14 }
    } as UpdateThemeInput) as { body: { size: number } }
    expect('theme_id' in out).toBe(false)
    expect('from_workspace_default' in out).toBe(false)
    expect(out.body.size).toBe(14)
  })

  it('preserves unrelated fields as-is', () => {
    const out = coerceThemePatch({ body: { size: 13 } } as UpdateThemeInput) as { body: { size: number } }
    expect(out.body.size).toBe(13)
  })

  it('empty patch → empty object', () => {
    expect(coerceThemePatch({} as UpdateThemeInput)).toEqual({})
  })
})

describe('mergeTheme', () => {
  it('overrides a leaf without touching siblings', () => {
    const merged = mergeTheme(defaultTheme, { body: { size: 14 } })
    expect(merged.body.size).toBe(14)
    // font/color/etc from the base survive
    expect(merged.body.font).toBe(defaultTheme.body.font)
    expect(merged.body.color).toBe(defaultTheme.body.color)
  })

  it('merges multiple sections independently', () => {
    const merged = mergeTheme(defaultTheme, {
      body: { size: 14 },
      color: { brand: '#ff0000' }
    })
    expect(merged.body.size).toBe(14)
    expect(merged.color.brand).toBe('#ff0000')
    // unrelated sections unchanged
    expect(merged.headings.font).toBe(defaultTheme.headings.font)
  })

  it('does NOT deep-merge further than one level (by design)', () => {
    // Documented tradeoff: theme shape is flat enough that two-level
    // merge is enough. If a patch ever sprouts a 3-deep nested object,
    // this test will flag the assumption to revisit.
    const base = defaultTheme
    const merged = mergeTheme(base, { header: { left: 'NEW' } })
    expect(merged.header.left).toBe('NEW')
    // center/right come from base (1-level merge)
    expect(merged.header.center).toBe(base.header.center)
    expect(merged.header.right).toBe(base.header.right)
  })

  it('returns a valid DocTheme shape when patch is empty', () => {
    const merged = mergeTheme(defaultTheme, {})
    expect(merged).toEqual(defaultTheme)
  })

  it('does not mutate the input theme', () => {
    const snapshot = JSON.stringify(defaultTheme)
    mergeTheme(defaultTheme, { body: { size: 99 } })
    expect(JSON.stringify(defaultTheme)).toBe(snapshot)
  })
})

describe('summarizePatch', () => {
  it('lists changed sections', () => {
    const s = summarizePatch({ body: { size: 12 }, color: { brand: '#fff' } } as UpdateThemeInput)
    expect(s).toContain('body')
    expect(s).toContain('color')
  })

  it('surfaces the preset id when present', () => {
    const s = summarizePatch({ preset: 'academic' } as UpdateThemeInput)
    expect(s).toContain('preset=academic')
  })

  it('combines preset + sections with a separator', () => {
    const s = summarizePatch({ preset: 'modern', layout: { columns: '2' } } as UpdateThemeInput)
    expect(s).toContain('preset=modern')
    expect(s).toContain('layout')
  })

  it('surfaces theme_id base source when present', () => {
    const s = summarizePatch({ theme_id: 'abc123', body: { size: 14 } } as UpdateThemeInput)
    expect(s).toContain('saved=abc123')
    expect(s).toContain('body')
  })

  it('surfaces from_workspace_default base source when present', () => {
    const s = summarizePatch({ from_workspace_default: true, color: { brand: '#000' } } as UpdateThemeInput)
    expect(s).toContain('workspace-default')
    expect(s).toContain('color')
  })

  it('reports "(no changes)" for empty patch', () => {
    expect(summarizePatch({} as UpdateThemeInput)).toBe('(no changes)')
  })

  it('ignores sub-objects that are empty', () => {
    // A section sent with no keys shouldn't count as "changed".
    const s = summarizePatch({ body: {} } as UpdateThemeInput)
    expect(s).toBe('(no changes)')
  })
})

describe('parseInternalFileRef', () => {
  it('parses a bare /api/files path', () => {
    expect(parseInternalFileRef('/api/files/abc123/def456.png')).toEqual({
      docId: 'abc123',
      fileId: 'def456.png'
    })
  })

  it('parses an absolute URL pointing at our /api/files', () => {
    expect(parseInternalFileRef('https://ypad.example.com/api/files/abc/def.jpg')).toEqual({
      docId: 'abc',
      fileId: 'def.jpg'
    })
  })

  it('ignores query strings and fragments', () => {
    expect(parseInternalFileRef('/api/files/abc/def.png?v=1')).toEqual({
      docId: 'abc',
      fileId: 'def.png'
    })
    expect(parseInternalFileRef('/api/files/abc/def.png#preview')).toEqual({
      docId: 'abc',
      fileId: 'def.png'
    })
  })

  it('returns null for non-matching paths', () => {
    expect(parseInternalFileRef('https://example.com/cat.png')).toBeNull()
    expect(parseInternalFileRef('/uploads/foo.png')).toBeNull()
    expect(parseInternalFileRef('')).toBeNull()
  })

  it('requires an extension (fileId shape matches the upload pipeline)', () => {
    // /api/files requires nanoid.ext — a path without an extension
    // isn't a valid file reference, so we should fall through to the
    // external-URL branch (which will then reject it).
    expect(parseInternalFileRef('/api/files/abc/def')).toBeNull()
  })

  it('refuses paths with extra segments after the file (no traversal matching)', () => {
    // The regex anchors to end-of-string / query / fragment after the
    // fileId, so a path like "/api/files/a/b.png/../other.png" won't
    // parse at all — the handler then rejects with "unsupported image
    // src". Belt-and-suspenders against path-traversal trickery: we
    // never return a (docId, fileId) pair pulled out of a longer path.
    expect(parseInternalFileRef('/api/files/attackerdoc/evil.png/../victim/file.png')).toBeNull()
    expect(parseInternalFileRef('/api/files/abc/def.png/extra')).toBeNull()
  })
})

describe('lineToCharOffset', () => {
  // Shared math for insert_text and generate_image — off-by-one here
  // puts generated images in the wrong paragraph silently.
  it('insert_line=0 maps to start of file', () => {
    expect(lineToCharOffset('a\nb\nc', 0)).toBe(0)
  })

  it('insert_line=N maps to start of line N+1', () => {
    // 'a\nb\nc': line 1='a', line 2='b', line 3='c'
    // insert_line=1 → after line 1 → start of line 2 (idx 2)
    expect(lineToCharOffset('a\nb\nc', 1)).toBe(2)
    expect(lineToCharOffset('a\nb\nc', 2)).toBe(4)
  })

  it('insert_line === lines.length clamps to end of file (no trailing newline)', () => {
    // 'hello\nworld'.split('\n') → ['hello', 'world'], length 2.
    // insert_line=2 would be idx 6+1=7 but full.length is 11, so clamp.
    const full = 'hello\nworld'
    expect(lineToCharOffset(full, 2)).toBe(full.length)
  })

  it('insert_line === lines.length is idx==full.length when doc has trailing newline', () => {
    // 'a\n'.split('\n') → ['a', ''], length 2. idx should be 2 (= full.length).
    const full = 'a\n'
    expect(lineToCharOffset(full, 2)).toBe(full.length)
  })

  it('returns null beyond EOF', () => {
    expect(lineToCharOffset('a\nb', 10)).toBeNull()
  })

  it('handles empty doc: insert_line=0 valid, others null', () => {
    // ''.split('\n') → [''], length 1.
    expect(lineToCharOffset('', 0)).toBe(0)
    expect(lineToCharOffset('', 1)).toBe(0) // clamped
    expect(lineToCharOffset('', 2)).toBeNull()
  })
})

describe('sanitizeAltText', () => {
  it('strips brackets and parens that would break markdown link syntax', () => {
    // ![alt](url) — a stray ] in alt text ends the bracket early and
    // fragments the rest into plain text. Drop them outright.
    expect(sanitizeAltText('photo of a [cat] (smiling)')).toBe('photo of a cat smiling')
  })

  it('collapses runs of whitespace', () => {
    expect(sanitizeAltText('a   b\n\tc')).toBe('a b c')
  })

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeAltText('  hello  ')).toBe('hello')
  })

  it('preserves unicode and punctuation that is markdown-safe', () => {
    expect(sanitizeAltText('café — 日本語! 🎉')).toBe('café — 日本語! 🎉')
  })

  it('empty input stays empty', () => {
    expect(sanitizeAltText('')).toBe('')
    expect(sanitizeAltText('   ')).toBe('')
  })
})

describe('parseDocIdFromInput', () => {
  it('extracts the id from a full markoto URL', () => {
    expect(parseDocIdFromInput('https://markoto.app/d/xyz123abc')).toBe('xyz123abc')
  })

  it('handles HTTP and any host', () => {
    expect(parseDocIdFromInput('http://localhost:3000/d/abc-_xyz')).toBe('abc-_xyz')
    expect(parseDocIdFromInput('https://staging.markoto.io/d/qrs99')).toBe('qrs99')
  })

  it('handles a root-relative path', () => {
    expect(parseDocIdFromInput('/d/aBc123_-')).toBe('aBc123_-')
  })

  it('tolerates trailing slash, query string, fragment', () => {
    expect(parseDocIdFromInput('https://markoto.app/d/xyz/')).toBe('xyz')
    expect(parseDocIdFromInput('https://markoto.app/d/xyz?slide=2')).toBe('xyz')
    expect(parseDocIdFromInput('https://markoto.app/d/xyz#top')).toBe('xyz')
  })

  it('accepts a bare id matching the URL-safe alphabet', () => {
    expect(parseDocIdFromInput('xyz123_-abc')).toBe('xyz123_-abc')
  })

  it('rejects an unrelated URL with no /d/<id> segment', () => {
    // Without the `/d/` segment we must NOT happily return some other
    // path leaf — that would be an exfil vector if the AI ever pasted
    // a stray URL.
    expect(parseDocIdFromInput('https://markoto.app/auth/github')).toBeNull()
    expect(parseDocIdFromInput('https://example.com/something')).toBeNull()
  })

  it('rejects whitespace-only input', () => {
    expect(parseDocIdFromInput('')).toBeNull()
    expect(parseDocIdFromInput('   ')).toBeNull()
  })

  it('rejects bare strings with disallowed characters', () => {
    expect(parseDocIdFromInput('not a valid id with spaces')).toBeNull()
    expect(parseDocIdFromInput('id.with.dots')).toBeNull()
  })

  it('trims surrounding whitespace before matching', () => {
    expect(parseDocIdFromInput('  https://markoto.app/d/xyz  ')).toBe('xyz')
    expect(parseDocIdFromInput('\txyz\n')).toBe('xyz')
  })
})

describe('update_theme custom CSS', () => {
  const ORIGINS = ['https://app.test']

  it('the tool schema accepts customCss and documents the restrictions', () => {
    expect(UpdateThemeArgs.safeParse({ customCss: 'p { color: red }' }).success).toBe(true)
    expect(UpdateThemeArgs.safeParse({ customCss: 42 }).success).toBe(false)
    const description = UpdateThemeArgs.shape.customCss.description ?? ''
    expect(description).toMatch(/@import/)
    expect(description).toMatch(/\/api\/files/)
  })

  it('mergeTheme sets and clears customCss', () => {
    expect(mergeTheme(defaultTheme, { customCss: 'p{color:red}' }).customCss).toBe('p{color:red}')
    expect(mergeTheme({ ...defaultTheme, customCss: 'p{}' }, { customCss: '' }).customCss).toBe('')
  })

  it('summarizePatch names customCss', () => {
    expect(summarizePatch({ customCss: 'p{}' } as UpdateThemeInput)).toBe('customCss')
  })

  it('rejects CSS the model sent when anything is wrong, with line/column', () => {
    const merged = { ...defaultTheme, customCss: 'p { color: red }\n@import "http://evil.test/x.css";' }
    const res = resolveThemeCustomCss(merged, true, 'doc1', ORIGINS)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/line 2, column 1: @import is not allowed/)
  })

  it('rejects an upload from another document sent by the model', () => {
    const merged = { ...defaultTheme, customCss: 'p { background: url(/api/files/doc2/a.png) }' }
    expect(resolveThemeCustomCss(merged, true, 'doc1', ORIGINS).ok).toBe(false)
  })

  it('passes clean CSS through untouched (formatting kept)', () => {
    const css = '/* note */\n.paged-doc h1 {\n  color: #123456;\n}\n'
    const res = resolveThemeCustomCss({ ...defaultTheme, customCss: css }, true, 'doc1', ORIGINS)
    expect(res).toEqual({ ok: true, theme: { ...defaultTheme, customCss: css }, note: '' })
  })

  it('adapts CSS inherited from a base theme instead of failing the call', () => {
    const merged = { ...defaultTheme, customCss: 'p { color: red; background: url(/api/files/doc2/a.png) }' }
    const res = resolveThemeCustomCss(merged, false, 'doc1', ORIGINS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.theme.customCss).toBe('p{color:red}')
      expect(res.note).toMatch(/1 custom CSS rule/)
    }
  })
})
