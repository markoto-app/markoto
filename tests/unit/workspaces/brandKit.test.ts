import { describe, expect, it } from 'vitest'
import { applyBrandLock } from '../../../shared/utils/theme/brandLock'
import { brandFontFaceCss, brandFontFamilies } from '../../../shared/utils/theme/brandFonts'
import { brandAssetDocUrl, brandImageFile, isThemeImageUrl, isThemeImageUrlForDoc, themeImagesForDoc } from '../../../shared/utils/theme/themeImages'
import { THEME_PRESETS } from '../../../shared/utils/theme/themePresets'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import type { BrandFont } from '../../../shared/config/brandKit'
import type { DocTheme } from '../../../shared/types/theme'

// Brand kitpure helpers: the locked workspace design, the brand
// fonts' @font-face rules, and brand images as theme image URLs.

const brand = THEME_PRESETS.find(p => p.id === 'business-report')!.theme as DocTheme

describe('applyBrandLock', () => {
  const own: DocTheme = {
    ...defaultTheme,
    cover: { ...defaultTheme.cover, subtitle: 'Q3 board update', authors: ['Maya Chen', 'Ben Ortiz'], affiliations: ['Finance', 'Ops'], date: '2026-11-10' },
    body: { ...defaultTheme.body, font: 'Comic Neue' },
    customCss: '.x { color: red }'
  }

  it('takes everything from the workspace design except the cover text', () => {
    const out = applyBrandLock(own, brand)
    expect(out.body).toEqual(brand.body)
    expect(out.headings).toEqual(brand.headings)
    expect(out.color).toEqual(brand.color)
    expect(out.customCss).toBe(brand.customCss)
    expect(out.cover.layout).toBe(brand.cover.layout)
    expect(out.cover.enabled).toBe(brand.cover.enabled)
    expect(out.cover.subtitle).toBe('Q3 board update')
    expect(out.cover.authors).toEqual(['Maya Chen', 'Ben Ortiz'])
    expect(out.cover.affiliations).toEqual(['Finance', 'Ops'])
    expect(out.cover.date).toBe('2026-11-10')
  })

  it('without a lock the document keeps its theme', () => {
    expect(applyBrandLock(own, null)).toBe(own)
  })

  it('ignores cover fields of the wrong shape (a theme written over Y.js)', () => {
    const broken = { ...own, cover: { subtitle: 42, authors: 'not a list', date: null } } as unknown as DocTheme
    const out = applyBrandLock(broken, brand)
    expect(out.cover.subtitle).toBe(brand.cover.subtitle)
    expect(out.cover.authors).toEqual(brand.cover.authors)
    expect(out.cover.date).toBeUndefined()
    expect(applyBrandLock(null, brand).body).toEqual(brand.body)
  })
})

describe('brandFontFaceCss', () => {
  const fonts: BrandFont[] = [
    { file: 'AbCdEfGhIjKlMnOp.woff2', family: 'Acme Sans', weight: 400, style: 'normal', format: 'woff2' },
    { file: 'QrStUvWxYz012345.ttf', family: 'Acme Sans', weight: 700, style: 'italic', format: 'ttf' }
  ]

  it('declares every face with its weight, style and format', () => {
    const css = brandFontFaceCss(fonts, file => `/api/docs/d1/brand/${file}?token=t`)
    expect(css).toContain(`@font-face { font-family: 'Acme Sans'; src: url('/api/docs/d1/brand/AbCdEfGhIjKlMnOp.woff2?token=t') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }`)
    expect(css).toContain(`format('truetype'); font-weight: 700; font-style: italic;`)
    expect(brandFontFamilies(fonts)).toEqual(['Acme Sans'])
  })

  it('cannot be used to inject CSS', () => {
    const evil = [
      { file: 'AbCdEfGhIjKlMnOp.woff2', family: 'x\'; } body { display: none } @font-face { font-family: \'y', weight: 400, style: 'normal', format: 'woff2' },
      { file: '../../etc/passwd', family: 'Ok', weight: 400, style: 'normal', format: 'woff2' },
      { file: 'AbCdEfGhIjKlMnOp.woff2', family: 'Ok', weight: 400, style: 'normal', format: 'svg' }
    ] as unknown as BrandFont[]
    expect(brandFontFaceCss(evil, f => f)).toBe('')
    // A URL with a quote can't close the url().
    const css = brandFontFaceCss([fonts[0]!], () => `/x');}body{display:none`)
    expect(css).not.toContain(`');}`)
  })

  it('skips faces this renderer has no URL for', () => {
    expect(brandFontFaceCss(fonts, () => '')).toBe('')
    expect(brandFontFaceCss(null, () => 'x')).toBe('')
  })
})

describe('brand images as theme images', () => {
  it('accepts /api/brand/<id>.<ext> for any document and maps it to the document route', () => {
    const url = '/api/brand/AbCdEfGhIjKlMnOp.png'
    expect(isThemeImageUrl(url)).toBe(true)
    expect(isThemeImageUrlForDoc(url, 'any-doc')).toBe(true)
    expect(brandImageFile(url)).toBe('AbCdEfGhIjKlMnOp.png')
    expect(brandAssetDocUrl('d1', 'AbCdEfGhIjKlMnOp.png')).toBe('/api/docs/d1/brand/AbCdEfGhIjKlMnOp.png')
    // Kept when a workspace design moves to a new document.
    const theme = { ...defaultTheme, brand: { ...defaultTheme.brand, logoUrl: url } }
    expect(themeImagesForDoc(theme, 'new-doc').dropped).toEqual([])
  })

  it('refuses other shapes', () => {
    for (const bad of ['/api/brand/short.png', '/api/brand/AbCdEfGhIjKlMnOp.svg', '/api/brand/AbCdEfGhIjKlMnOp.woff2', 'https://evil.example/api/brand/AbCdEfGhIjKlMnOp.png', '/api/brand/AbCdEfGhIjKlMnOp.png?x=1']) {
      expect(isThemeImageUrl(bad), bad).toBe(false)
      expect(brandImageFile(bad), bad).toBeNull()
    }
  })
})
