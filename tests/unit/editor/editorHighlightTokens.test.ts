import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the CodeMirror markdown highlight tokens (`--mk-md-*`) in
 * `app/assets/css/main.css`. Regression: the dark-mode overrides used to
 * live in a `.dark` rule, which has the same specificity as the light
 * `:root` rule declared after it — so the light values won in dark mode
 * and headings / strong / code rendered sumi-950 on the sumi-900 editor
 * bg (≈1:1 contrast, invisible). The overrides must sit in a rule that
 * outranks `:root` and must keep content text readable in both modes.
 */

const css = readFileSync(join(__dirname, '../../../app/assets/css/main.css'), 'utf8')

/** Declarations of every top-level rule whose selector is exactly `selector`. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g')
  for (const match of css.matchAll(re)) {
    for (const decl of (match[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(decl[1] ?? '', (decl[2] ?? '').trim())
    }
  }
  return out
}

const palette = new Map<string, string>()
for (const m of css.matchAll(/(--color-(?:sumi|shu)-\d+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
  palette.set(m[1] ?? '', m[2] ?? '')
}

function hex(value: string): string {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  const resolved = ref ? palette.get(ref) : value
  if (!resolved) throw new Error(`unresolvable colour ${value}`)
  return resolved
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const light = declarations(':root')
const dark = declarations(':root.dark')
const mdTokens = [...light.keys()].filter(k => k.startsWith('--mk-md-'))

// Content text (not the deliberately muted markup marks / code comments).
const CONTENT_TOKENS = ['--mk-md-h1', '--mk-md-h2', '--mk-md-h3', '--mk-md-h4', '--mk-md-h56', '--mk-md-strong', '--mk-md-quote', '--mk-md-list', '--mk-md-syntax', '--mk-md-syntax-strong']
const LIGHT_EDITOR_BG = '#FFFFFF' // bg-default, light
const DARK_EDITOR_BG = palette.get('--color-sumi-900') ?? '' // bg-default, dark

describe('editor highlight tokens', () => {
  test('light tokens are defined on :root', () => {
    expect(mdTokens.length).toBeGreaterThanOrEqual(15)
  })

  test('dark overrides live on :root.dark (outranks :root regardless of order) and cover every token', () => {
    expect([...dark.keys()].filter(k => k.startsWith('--mk-md-')).sort()).toEqual([...mdTokens].sort())
  })

  test('no plain `.dark` rule declares --mk-md-* (it would lose to :root)', () => {
    expect([...declarations('.dark').keys()].filter(k => k.startsWith('--mk-md-'))).toEqual([])
  })

  test.each(CONTENT_TOKENS)('%s meets WCAG AA (4.5:1) in light and dark mode', (token) => {
    expect(contrast(hex(light.get(token) ?? ''), LIGHT_EDITOR_BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex(dark.get(token) ?? ''), DARK_EDITOR_BG)).toBeGreaterThanOrEqual(4.5)
  })

  // Custom CSS editor (ThemeCustomCssSection.vue) syntax colours.
  const cssTokens = [...light.keys()].filter(k => k.startsWith('--mk-css-'))
  test('custom CSS syntax tokens have a dark override each', () => {
    expect(cssTokens.length).toBeGreaterThanOrEqual(5)
    expect([...dark.keys()].filter(k => k.startsWith('--mk-css-')).sort()).toEqual([...cssTokens].sort())
  })
  test.each(['--mk-css-selector', '--mk-css-property', '--mk-css-at', '--mk-css-number', '--mk-css-string'])('%s meets WCAG AA (4.5:1) in light and dark mode', (token) => {
    expect(contrast(hex(light.get(token) ?? ''), LIGHT_EDITOR_BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex(dark.get(token) ?? ''), DARK_EDITOR_BG)).toBeGreaterThanOrEqual(4.5)
  })

  test('inline code foreground meets AA on its own chip background in both modes', () => {
    expect(contrast(hex(light.get('--mk-md-code-fg') ?? ''), hex(light.get('--mk-md-code-bg') ?? ''))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex(dark.get('--mk-md-code-fg') ?? ''), hex(dark.get('--mk-md-code-bg') ?? ''))).toBeGreaterThanOrEqual(4.5)
  })
})
