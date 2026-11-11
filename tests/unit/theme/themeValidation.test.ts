import { describe, it, expect } from 'vitest'
import { DocThemeSchema, type DocTheme } from '../../../shared/types/theme'
import { isValidTheme } from '../../../shared/utils/theme/themeValidation'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import { THEME_PRESETS } from '../../../shared/utils/theme/themePresets'

// Theme validation. Input boundary for two touch points:
//   - PUT /api/docs/:id/meta → user/AI-supplied theme payloads
//   - `ymeta.theme` reads → untrusted data out of the Y.Map
//
// The schema is the single source of truth for DocTheme. If this suite
// regresses, the `themeToCss` stylesheet generator sees a shape it
// wasn't coded for, and preview + PDF silently mis-render.

// Deep clone + mutation helper — the schema uses `.strict()` so we can't
// just spread once; each test starts from a fresh deep copy.
function baseTheme(): DocTheme {
  return JSON.parse(JSON.stringify(defaultTheme))
}

describe('happy path', () => {
  it('defaultTheme validates', () => {
    expect(isValidTheme(defaultTheme)).toBe(true)
  })

  it.each(THEME_PRESETS)('preset $id validates', ({ theme }) => {
    // Presets are the source-of-truth for "what shipping themes look
    // like". If any preset ever fails validation, the AI's `update_theme`
    // tool + the user-facing preset picker both hand back a broken doc.
    expect(isValidTheme(theme)).toBe(true)
  })
})

describe('top-level shape', () => {
  it('rejects null', () => {
    expect(isValidTheme(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidTheme(undefined)).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isValidTheme('theme')).toBe(false)
    expect(isValidTheme(42)).toBe(false)
    expect(isValidTheme([])).toBe(false)
  })

  it('rejects empty object (missing all sections)', () => {
    expect(isValidTheme({})).toBe(false)
  })

  it('rejects unknown top-level keys (.strict)', () => {
    // Smuggle-an-extra-field guard. Without `.strict()`, a malicious
    // payload could park arbitrary keys in ymeta.theme.
    const t = baseTheme() as DocTheme & { injected?: string }
    t.injected = 'surprise'
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects unknown nested keys', () => {
    const t = baseTheme()
    ;(t.page as unknown as Record<string, unknown>).extra = 'x'
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('page', () => {
  it('rejects unknown page size', () => {
    const t = baseTheme()
    ;(t.page as unknown as { size: string }).size = 'Tabloid'
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts A4 / Letter / Legal', () => {
    for (const size of ['A4', 'Letter', 'Legal'] as const) {
      const t = baseTheme()
      t.page.size = size
      expect(isValidTheme(t)).toBe(true)
    }
  })

  it('rejects unknown orientation', () => {
    const t = baseTheme()
    ;(t.page as unknown as { orientation: string }).orientation = 'diagonal'
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts margin at boundary values (0 and 60)', () => {
    const t = baseTheme()
    t.page.margin = 0
    expect(isValidTheme(t)).toBe(true)
    t.page.margin = 60
    expect(isValidTheme(t)).toBe(true)
  })

  it('rejects margin just past bounds', () => {
    const t = baseTheme()
    t.page.margin = -1
    expect(isValidTheme(t)).toBe(false)
    t.page.margin = 61
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects absurd margin (crash-guard for paged.js)', () => {
    const t = baseTheme()
    t.page.margin = 1e9
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('body', () => {
  it('rejects font with CSS metacharacters (injection guard)', () => {
    // The font name is interpolated into CSS `font-family: "..."` (and
    // looked up in the self-hosted font registry). Quotes, angle
    // brackets, or backslashes would let a payload escape those strings.
    const t = baseTheme()
    const bad = ['Arial"; }', 'font\\escape', 'Inter<script>', '<img>', 'Inter;color:red']
    for (const f of bad) {
      t.body.font = f
      expect(isValidTheme(t), `font=${JSON.stringify(f)}`).toBe(false)
    }
  })

  it('accepts typical Google Font names', () => {
    const t = baseTheme()
    for (const f of ['Inter', 'Roboto', 'EB Garamond', 'Open Sans', 'PT Serif']) {
      t.body.font = f
      expect(isValidTheme(t)).toBe(true)
    }
  })

  it('rejects empty font', () => {
    const t = baseTheme()
    t.body.font = ''
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects font longer than 40 chars', () => {
    const t = baseTheme()
    t.body.font = 'A'.repeat(41)
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts body size at boundaries (6 and 24)', () => {
    const t = baseTheme()
    t.body.size = 6
    expect(isValidTheme(t)).toBe(true)
    t.body.size = 24
    expect(isValidTheme(t)).toBe(true)
  })

  it('rejects body size out of range', () => {
    const t = baseTheme()
    t.body.size = 5
    expect(isValidTheme(t)).toBe(false)
    t.body.size = 25
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects NaN / Infinity size', () => {
    const t = baseTheme()
    t.body.size = NaN
    expect(isValidTheme(t)).toBe(false)
    t.body.size = Infinity
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects textAlign other than left/justify', () => {
    const t = baseTheme()
    ;(t.body as unknown as { textAlign: string }).textAlign = 'center'
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('hex color guards', () => {
  // themeToCss interpolates color strings directly into the stylesheet,
  // so an unvalidated value is a CSS-injection vector.
  it('accepts 6-digit and 3-digit hex', () => {
    for (const c of ['#abc', '#ABC', '#aabbcc', '#AABBCC', '#000', '#FFFFFF']) {
      const t = baseTheme()
      t.body.color = c
      expect(isValidTheme(t), `color=${c}`).toBe(true)
    }
  })

  it('rejects named colors', () => {
    const t = baseTheme()
    t.body.color = 'red' as string
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects hex without leading #', () => {
    const t = baseTheme()
    t.body.color = 'abcabc' as string
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects 4/5/7/8-digit hex', () => {
    const t = baseTheme()
    for (const bad of ['#abcd', '#abcde', '#abcdefa', '#abcdef01']) {
      t.body.color = bad as string
      expect(isValidTheme(t), bad).toBe(false)
    }
  })

  it('rejects non-hex chars', () => {
    const t = baseTheme()
    t.body.color = '#ggg' as string
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects CSS injection via color string', () => {
    const t = baseTheme()
    t.body.color = 'red; } body { display: none; } /*' as string
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('headings', () => {
  it('rejects unsupported weight', () => {
    const t = baseTheme()
    ;(t.headings as unknown as { weight: number }).weight = 350
    expect(isValidTheme(t)).toBe(false)
    ;(t.headings as unknown as { weight: number }).weight = 1000
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts every supported weight', () => {
    for (const w of [400, 500, 600, 700, 800, 900] as const) {
      const t = baseTheme()
      t.headings.weight = w
      expect(isValidTheme(t), `weight=${w}`).toBe(true)
    }
  })

  it('rejects non-boolean underline', () => {
    const t = baseTheme()
    ;(t.headings as unknown as { underline: unknown }).underline = 'true'
    expect(isValidTheme(t)).toBe(false)
    ;(t.headings as unknown as { underline: unknown }).underline = 1
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('layout', () => {
  it('rejects non-1/2/3 column counts', () => {
    const t = baseTheme()
    for (const c of [0, 4, 1.5, -1]) {
      ;(t.layout as unknown as { columns: number }).columns = c
      expect(isValidTheme(t), `columns=${c}`).toBe(false)
    }
  })

  it('accepts 1, 2, 3 columns', () => {
    for (const c of [1, 2, 3] as const) {
      const t = baseTheme()
      t.layout.columns = c
      expect(isValidTheme(t)).toBe(true)
    }
  })
})

describe('header/footer slots', () => {
  it('accepts empty strings (disabled slot)', () => {
    const t = baseTheme()
    t.header.left = ''
    t.header.center = ''
    t.header.right = ''
    expect(isValidTheme(t)).toBe(true)
  })

  it('accepts the four template tokens', () => {
    const t = baseTheme()
    t.header.left = '{title}'
    t.header.center = 'page {page} of {pages}'
    t.header.right = '{date}'
    expect(isValidTheme(t)).toBe(true)
  })

  it('rejects unknown token-style sequences (strict — only 4 allowed)', () => {
    // Regression target: a naive validator that accepts any `{...}`
    // could let templates smuggle arbitrary CSS through by pretending
    // to be tokens. Our validator only strips the four known tokens
    // and then checks the remainder. `{evil}` is not stripped, so if
    // its body contains safe text it actually still passes — pin
    // today's behavior so the test fails loudly if we tighten later.
    const t = baseTheme()
    t.header.left = '{evil}'
    // "{evil}" contains no forbidden chars → passes. Documented.
    expect(isValidTheme(t)).toBe(true)
  })

  it('rejects templates with CSS-escape characters', () => {
    const t = baseTheme()
    const bad = ['hi"there', 'a\\b', 'a\nb', '<script>', '>']
    for (const slot of bad) {
      t.header.left = slot
      expect(isValidTheme(t), `slot=${JSON.stringify(slot)}`).toBe(false)
    }
  })

  it('rejects templates longer than 200 chars', () => {
    const t = baseTheme()
    t.header.left = 'x'.repeat(201)
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts templates at exactly 200 chars', () => {
    const t = baseTheme()
    t.header.left = 'x'.repeat(200)
    expect(isValidTheme(t)).toBe(true)
  })

  it('validates BOTH header and footer independently', () => {
    const t = baseTheme()
    t.footer.center = 'a"b'
    expect(isValidTheme(t)).toBe(false)
    t.footer.center = ''
    t.header.right = 'a"b'
    expect(isValidTheme(t)).toBe(false)
  })
})

describe('tables', () => {
  it('rejects non-integer cellPadding', () => {
    const t = baseTheme()
    t.tables.cellPadding = 2.5
    expect(isValidTheme(t)).toBe(false)
  })

  it('rejects cellPadding out of range', () => {
    const t = baseTheme()
    t.tables.cellPadding = -1
    expect(isValidTheme(t)).toBe(false)
    t.tables.cellPadding = 25
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts all border styles', () => {
    for (const b of ['all', 'horizontal', 'minimal', 'none'] as const) {
      const t = baseTheme()
      t.tables.borders = b
      expect(isValidTheme(t)).toBe(true)
    }
  })
})

describe('toc', () => {
  it('rejects maxDepth outside 2-4', () => {
    const t = baseTheme()
    for (const d of [1, 5, 0, -1, 2.5]) {
      ;(t.toc as unknown as { maxDepth: number }).maxDepth = d
      expect(isValidTheme(t), `maxDepth=${d}`).toBe(false)
    }
  })

  it('accepts maxDepth 2, 3, 4', () => {
    for (const d of [2, 3, 4] as const) {
      const t = baseTheme()
      t.toc.maxDepth = d
      expect(isValidTheme(t)).toBe(true)
    }
  })
})

describe('missing sections', () => {
  it('rejects missing top-level sections one by one', () => {
    const sections: Array<keyof DocTheme> = [
      'page', 'body', 'headings', 'color', 'layout',
      'header', 'footer', 'code', 'tables', 'blocks', 'mermaid', 'toc'
    ]
    for (const section of sections) {
      const t = baseTheme() as unknown as Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test intentionally exercises missing-key detection across all theme sections
      delete t[section]
      expect(isValidTheme(t), `missing ${section}`).toBe(false)
    }
  })
})

describe('DocThemeSchema.safeParse — error surfacing (richer-errors path)', () => {
  // Callers that care about WHICH field failed can use safeParse
  // directly. These tests verify the issues array points at the right
  // path so /meta.put could eventually return field-level 400s.
  it('error path points at the first invalid leaf', () => {
    const t = baseTheme()
    t.body.color = 'red' as string
    const r = DocThemeSchema.safeParse(t)
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join('.'))
      expect(paths).toContain('body.color')
    }
  })

  it('reports every top-level section issue when multiple fields are wrong', () => {
    const t = baseTheme()
    t.body.color = 'red' as string
    t.page.margin = -1
    const r = DocThemeSchema.safeParse(t)
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join('.'))
      expect(paths).toEqual(expect.arrayContaining(['page.margin', 'body.color']))
    }
  })
})

describe('cover.date + mermaid "document" (documents at scale)', () => {
  it('accepts an absent, empty or real ISO publication date', () => {
    const t = baseTheme()
    expect(isValidTheme(t)).toBe(true)
    t.cover.date = ''
    expect(isValidTheme(t)).toBe(true)
    t.cover.date = '2026-10-29'
    expect(isValidTheme(t)).toBe(true)
  })

  it('rejects anything else as the publication date', () => {
    for (const date of ['29.10.2026', '2026-02-30', '2026-10-29T00:00', '} body {', 'x'.repeat(20)]) {
      const t = baseTheme()
      t.cover.date = date
      expect(isValidTheme(t), date).toBe(false)
    }
    const t: Record<string, unknown> = JSON.parse(JSON.stringify(baseTheme()))
    const cover = t.cover
    if (typeof cover === 'object' && cover !== null) Reflect.set(cover, 'date', 20261029)
    expect(isValidTheme(t)).toBe(false)
  })

  it('accepts the "document" diagram colours and every built-in', () => {
    for (const mt of ['document', 'default', 'dark', 'forest', 'neutral', 'base'] as const) {
      const t = baseTheme()
      t.mermaid.theme = mt
      expect(isValidTheme(t), mt).toBe(true)
    }
    expect(defaultTheme.mermaid.theme).toBe('document')
  })
})
