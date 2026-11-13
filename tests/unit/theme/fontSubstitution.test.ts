import { describe, expect, it } from 'vitest'
import { compactFontName, substituteFont } from '../../../shared/utils/theme/fontSubstitution'
import { CODE_FONT_NAMES, THEME_FONTS } from '../../../shared/utils/theme/themeFonts'

describe('compactFontName', () => {
  it.each([
    ['ABCDEF+TimesNewRomanPSMT', 'timesnew'],
    ['Arial-BoldMT', 'arial'],
    ['LiberationSans-Bold', 'liberationsans'],
    ['Calibri,Bold', 'calibri'],
    ['WorkSans-SemiBold', 'worksans'],
    ['Source Sans 3', 'sourcesans3'],
    ['HelveticaNeueLight', 'helveticaneue']
  ])('%s → %s', (raw, compact) => {
    expect(compactFontName(raw)).toBe(compact)
  })
})

describe('substituteFont', () => {
  it('keeps a registry font as an exact match, whatever its spelling', () => {
    expect(substituteFont('WorkSans-SemiBold')).toEqual({ name: 'Work Sans', exact: true, category: 'sans' })
    expect(substituteFont('EB Garamond')).toEqual({ name: 'EB Garamond', exact: true, category: 'serif' })
    expect(substituteFont('ABCDEF+SourceSerif4-Regular').name).toBe('Source Serif 4')
  })

  it.each([
    ['Times New Roman', 'TeX Gyre Termes'],
    ['ABCDEF+TimesNewRomanPSMT', 'TeX Gyre Termes'],
    ['Arial-BoldMT', 'TeX Gyre Heros'],
    ['LiberationSans', 'TeX Gyre Heros'],
    ['Helvetica Neue', 'Inter'],
    ['Calibri', 'Lato'],
    ['Calibri Light', 'Lato'],
    ['Cambria', 'PT Serif'],
    ['Georgia', 'Merriweather'],
    ['Garamond', 'EB Garamond'],
    ['Minion Pro', 'Crimson Text'],
    ['Segoe UI', 'Open Sans'],
    ['NotoSerif-Regular', 'Source Serif 4'],
    ['Futura PT', 'DM Sans'],
    ['Baskerville', 'Libre Baskerville']
  ])('%s → %s', (raw, name) => {
    const sub = substituteFont(raw)
    expect(sub.name).toBe(name)
    expect(sub.exact).toBe(false)
  })

  it('guesses the category of an unknown family', () => {
    expect(substituteFont('Acme Corporate Serif')).toMatchObject({ name: 'Source Serif 4', category: 'serif' })
    expect(substituteFont('Zenith Grotesk')).toMatchObject({ name: 'Inter', category: 'sans' })
    expect(substituteFont('')).toMatchObject({ name: 'Inter', category: 'sans' })
  })

  it('code gets a monospace family, text never does', () => {
    expect(substituteFont('Courier New', 'code').name).toBe('IBM Plex Mono')
    expect(substituteFont('Consolas', 'code').name).toBe('JetBrains Mono')
    expect(substituteFont('Arial', 'code').category).toBe('mono')
    expect(substituteFont('Courier New').category).not.toBe('mono')
    expect(substituteFont('Fancy Typewriter Mono').category).toBe('sans')
  })

  it('always answers with a family we serve', () => {
    const text = new Set(THEME_FONTS.map(f => f.name))
    const code = new Set<string>(CODE_FONT_NAMES)
    for (const raw of ['Wingdings', 'ABCDEF+Unknown-Bold', 'Comic Sans MS', 'Courier', 'Frutiger LT 55']) {
      expect(text.has(substituteFont(raw).name)).toBe(true)
      expect(code.has(substituteFont(raw, 'code').name)).toBe(true)
    }
  })
})
