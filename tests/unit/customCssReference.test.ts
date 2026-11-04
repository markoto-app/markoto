import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  CUSTOM_CSS_AI_REFERENCE,
  CUSTOM_CSS_ALLOWED_AT_RULES,
  CUSTOM_CSS_COVER_HOOKS,
  CUSTOM_CSS_HOOKS,
  CUSTOM_CSS_PAGE_HOOKS,
  CUSTOM_CSS_REFUSED_AT_RULES,
  CUSTOM_CSS_VARIABLES
} from '../../shared/utils/customCssReference'
import { sanitizeCustomCss } from '../../shared/utils/customCss'
import { themeToCss } from '../../shared/utils/themeToCss'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { UpdateThemeArgs } from '../../server/utils/agentic/functionTools'
import { PROMPT_SYSTEM_PROMPT } from '../../server/utils/agentic/promptAssembly'
import { COMMENT_TRIGGER_SYSTEM_PROMPT } from '../../server/utils/agentic/commentTriggerPrompt'

// The custom-CSS reference is shown to the AI (tool description) and
// documented for people (content/docs/themes/custom-css.md). These tests
// tie it to the code that actually decides: the selectors and variables
// themeToCss emits, and what the sanitizer accepts or refuses.

const css = themeToCss(
  { ...defaultTheme, cover: { ...defaultTheme.cover, enabled: true }, body: { ...defaultTheme.body, dropCap: true } },
  { title: 'T', date: '3 November 2026', tocTitle: 'Contents' }
)
const selectorLines = [...css.matchAll(/^([^{}\n]+)\{/gm)].map(m => m[1]!.trim())

const docsPage = readFileSync(
  fileURLToPath(new URL('../../content/docs/themes/custom-css.md', import.meta.url)),
  'utf8'
)

const opts = { docId: 'doc123', allowedOrigins: [] }

describe('custom CSS reference — matches themeToCss', () => {
  test.each([...CUSTOM_CSS_HOOKS, ...CUSTOM_CSS_COVER_HOOKS].map(h => h.selector))('%s is a selector themeToCss styles', (selector) => {
    expect(selectorLines.some(line => line.split(',').map(s => s.trim()).includes(selector))).toBe(true)
  })

  test.each(CUSTOM_CSS_VARIABLES.map(v => v.selector))('%s is defined on .paged-doc', (variable) => {
    expect(css).toMatch(new RegExp(`\\.paged-doc \\{[^}]*${variable}:`))
  })

  test('page hooks exist in the generated CSS', () => {
    expect(css).toMatch(/@page\s*\{/)
    expect(css).toMatch(/@page cover-page\s*\{/)
    expect(css).toContain('@top-center')
  })
})

describe('custom CSS reference — matches the sanitizer', () => {
  const samples: Record<(typeof CUSTOM_CSS_ALLOWED_AT_RULES)[number], string> = {
    '@media': '@media print { .paged-doc h2 { color: red } }',
    '@supports': '@supports (display: grid) { .paged-doc p { color: red } }',
    '@page': '@page :first { @top-center { content: none } }',
    '@keyframes': '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }',
    '@container': '@container (min-width: 10px) { .paged-doc p { color: red } }',
    '@layer': '@layer base { .paged-doc p { color: red } }',
    '@font-feature-values': '@font-feature-values Inter { @styleset { alt: 1 } }'
  }
  test.each(CUSTOM_CSS_ALLOWED_AT_RULES)('%s is accepted', (rule) => {
    expect(sanitizeCustomCss(samples[rule], opts).issues).toEqual([])
  })

  test.each(CUSTOM_CSS_REFUSED_AT_RULES)('%s is refused', (rule) => {
    const res = sanitizeCustomCss(`${rule} x { color: red }`, opts)
    expect(res.issues.map(i => i.code)).toContain('at-rule')
  })

  test('the cover page and margin-box hooks are accepted', () => {
    const res = sanitizeCustomCss('@page cover-page { margin: 0 } @page { @bottom-center { content: counter(page) " / " counter(pages) } }', opts)
    expect(res.issues).toEqual([])
  })
})

describe('custom CSS docs page', () => {
  test.each([
    ...CUSTOM_CSS_HOOKS, ...CUSTOM_CSS_COVER_HOOKS, ...CUSTOM_CSS_VARIABLES, ...CUSTOM_CSS_PAGE_HOOKS
  ].map(h => h.selector))('documents %s', (selector) => {
    expect(docsPage).toContain(selector)
  })

  test.each([...CUSTOM_CSS_ALLOWED_AT_RULES, ...CUSTOM_CSS_REFUSED_AT_RULES])('mentions %s', (rule) => {
    expect(docsPage).toContain(rule)
  })

  test('every CSS example on the page passes the sanitizer', () => {
    const blocks = [...docsPage.matchAll(/```css\n([\s\S]*?)```/g)].map(m => m[1]!)
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    for (const block of blocks) {
      expect(sanitizeCustomCss(block, opts).issues, block).toEqual([])
    }
  })
})

describe('the AI knows custom CSS', () => {
  const customCssField = UpdateThemeArgs.shape.customCss

  test('the update_theme customCss field carries the reference', () => {
    expect(customCssField.description).toContain(CUSTOM_CSS_AI_REFERENCE)
    for (const hook of [...CUSTOM_CSS_HOOKS, ...CUSTOM_CSS_COVER_HOOKS, ...CUSTOM_CSS_VARIABLES]) {
      expect(customCssField.description).toContain(hook.selector)
    }
  })

  test('it tells the model to prefer theme fields and keep existing CSS', () => {
    expect(customCssField.description).toMatch(/LAST RESORT/)
    expect(customCssField.description).toMatch(/get_theme first/)
    expect(PROMPT_SYSTEM_PROMPT).toMatch(/theme fields first, then `update_theme` with `customCss` as the fallback/)
    expect(COMMENT_TRIGGER_SYSTEM_PROMPT).toMatch(/theme fields first, then `update_theme` with `customCss`/)
  })

  test('the reference is static (cache-friendly): no dates, ids or times', () => {
    expect(CUSTOM_CSS_AI_REFERENCE).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(CUSTOM_CSS_AI_REFERENCE).not.toMatch(/\b\d\d:\d\d\b/)
    expect(CUSTOM_CSS_AI_REFERENCE).toContain('/api/files/<this doc id>/<file id>')
  })
})
