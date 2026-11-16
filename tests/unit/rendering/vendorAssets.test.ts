import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildFontCss,
  checkVendorPackages,
  generateVendorAssets,
  installedVersion,
  lockedVendorFiles,
  parseFontsourceCss,
  PINNED_VERSIONS,
  sriOf,
  type GeneratedSummary
} from '../../../scripts/lib/vendorAssets'
import { FONT_STYLESHEET_BASE, SELF_HOSTED_FONTS, THEME_FONTS, fontStylesheetUrl, fontStylesheetUrls, selfHostedFont, uiFontStylesheetUrls } from '../../../shared/utils/theme/themeFonts'
import { THEME_PRESETS } from '../../../shared/utils/theme/themePresets'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import { VENDOR_BASE } from '../../../shared/utils/vendor/vendorAssets'
import { KATEX_CSS_URL } from '../../../shared/utils/vendor/katexAssets'
import { vendorAssetHeaders } from '../../../server/utils/rendering/vendorAssetHeaders'

// Pins for the same-origin third-party assets (shared/utils/vendor/vendorAssets.ts):
// the version + SRI constants match the installed packages, the generator
// emits woff2-only, same-origin font stylesheets, and every font the app or
// a theme preset names is actually served.

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('pinned constants vs installed packages', () => {
  it('every version + SRI constant matches node_modules', () => {
    expect(checkVendorPackages(ROOT)).toEqual([])
  })

  it('the hashes are the real bytes of each file', () => {
    for (const file of lockedVendorFiles()) {
      const bytes = readFileSync(join(ROOT, 'node_modules', file.package, file.from))
      expect(sriOf(bytes), file.from).toBe(file.sri)
    }
  })

  it('package.json allows exactly the pinned versions', () => {
    for (const [pkg, version] of Object.entries(PINNED_VERSIONS)) {
      const spec = rootPackage.dependencies[pkg] ?? rootPackage.devDependencies[pkg]
      expect(spec, pkg).toBeDefined()
      expect(spec?.replace(/^\^/, ''), pkg).toBe(version)
      expect(installedVersion(ROOT, pkg), pkg).toBe(version)
    }
  })

  it('font packages are exact-pinned (a font update is a reviewed change)', () => {
    for (const font of SELF_HOSTED_FONTS) {
      const packages = [...(font.source.kind === 'fontsource' ? [font.source.package] : []), ...(font.ui ? [font.ui.package] : [])]
      for (const pkg of packages) {
        const spec = rootPackage.devDependencies[pkg]
        expect(spec, pkg).toMatch(/^\d+\.\d+\.\d+$/)
        expect(installedVersion(ROOT, pkg)).toBe(spec)
      }
    }
  })

  it('documents use static font cuts only (Chromium prints variable fonts as Type 3)', () => {
    for (const font of SELF_HOSTED_FONTS) {
      if (font.source.kind !== 'fontsource') continue
      expect(font.source.package, font.name).toMatch(/^@fontsource\//)
      for (const sheet of font.source.stylesheets) expect(sheet, font.name).toMatch(/^\d00(?:-italic)?\.css$/)
    }
    // Only the app shell's brand fonts keep a variable cut.
    expect(SELF_HOSTED_FONTS.filter(f => f.ui).map(f => f.name).sort()).toEqual(['Fraunces', 'Inter', 'JetBrains Mono'])
    expect(uiFontStylesheetUrls(['Fraunces', 'Lato'])).toEqual([`${FONT_STYLESHEET_BASE}fraunces.variable.css`, `${FONT_STYLESHEET_BASE}lato.css`])
  })

  it('bundled font families ship their woff2 files and licence', () => {
    const bundled = SELF_HOSTED_FONTS.filter(f => f.source.kind === 'bundled')
    expect(bundled.map(f => f.name)).toEqual(expect.arrayContaining(['TeX Gyre Termes', 'TeX Gyre Heros', 'Latin Modern Mono', 'Latin Modern Roman']))
    for (const font of bundled) {
      if (font.source.kind !== 'bundled') continue
      const dir = join(ROOT, 'fonts', font.slug)
      expect(readFileSync(join(dir, 'LICENSE.txt'), 'utf8'), font.name).toContain('GUST Font License')
      for (const face of font.source.faces) {
        expect(!face.licence || readFileSync(join(dir, face.licence), 'utf8').includes('SIL OPEN FONT LICENSE'), `${face.file}: SIL OPEN FONT LICENSE`).toBe(true)
        const bytes = readFileSync(join(dir, face.file))
        // WOFF2 signature 'wOF2'
        expect(bytes.subarray(0, 4).toString('latin1'), face.file).toBe('wOF2')
        expect(bytes.length, face.file).toBeLessThan(80_000)
      }
    }
  })

  it('every URL is a versioned same-origin /vendor/ path', () => {
    for (const file of lockedVendorFiles()) {
      expect(file.url.startsWith(VENDOR_BASE), file.url).toBe(true)
      expect(file.url).toContain(`/${file.package}@${PINNED_VERSIONS[file.package]}/`)
    }
  })
})

describe('font registry', () => {
  it('serves every family the picker, the presets, the default theme and the app shell use', () => {
    const used = new Set<string>([
      ...THEME_FONTS.map(f => f.name),
      ...THEME_PRESETS.flatMap(p => [p.theme.body.font, p.theme.headings.font, p.theme.meta.font]),
      defaultTheme.body.font, defaultTheme.headings.font, defaultTheme.meta.font,
      // app/assets/css/main.css --font-sans / --font-mono / --font-serif
      'Inter', 'JetBrains Mono', 'Fraunces'
    ])
    for (const name of used) expect(selfHostedFont(name), name).not.toBeNull()
  })

  it('keeps the curated picker: 20 Fontsource families + 3 bundled TeX families', () => {
    expect(THEME_FONTS).toHaveLength(23)
    expect(THEME_FONTS.map(f => f.name)).toEqual(expect.arrayContaining(['TeX Gyre Termes', 'TeX Gyre Heros', 'Latin Modern Roman']))
    expect(new Set(SELF_HOSTED_FONTS.map(f => f.slug)).size).toBe(SELF_HOSTED_FONTS.length)
  })

  it('maps names to same-origin stylesheets, and unknown families to nothing', () => {
    expect(fontStylesheetUrl('Source Serif 4')).toBe(`${FONT_STYLESHEET_BASE}source-serif-4.css`)
    expect(fontStylesheetUrl('  inter ')).toBe(`${FONT_STYLESHEET_BASE}inter.css`)
    expect(fontStylesheetUrl('Comic Neue')).toBeNull()
    expect(fontStylesheetUrl('')).toBeNull()
    expect(fontStylesheetUrls(['Inter', 'Inter', 'Nope', null, 'Lora'])).toEqual([
      `${FONT_STYLESHEET_BASE}inter.css`,
      `${FONT_STYLESHEET_BASE}lora.css`
    ])
  })
})

describe('font stylesheet generation', () => {
  const sample = `/* lato-latin-400-normal */
@font-face {
  font-family: 'Lato';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/lato-latin-400-normal.woff2) format('woff2'), url(./files/lato-latin-400-normal.woff) format('woff');
  unicode-range: U+0000-00FF,U+0131;
}`

  it('keeps the woff2 source only and renames the family to the theme name', () => {
    const faces = parseFontsourceCss(sample)
    expect(faces).toEqual([{ style: 'normal', weight: '400', unicodeRange: 'U+0000-00FF,U+0131', file: 'lato-latin-400-normal.woff2' }])
    const font = selfHostedFont('Lato')
    if (!font) throw new Error('Lato missing')
    const css = buildFontCss(font, '5.3.0', faces)
    expect(css).toContain('font-family: \'Lato\';')
    expect(css).toContain('font-display: swap;')
    expect(css).toContain('src: url(\'lato@5.3.0/lato-latin-400-normal.woff2\') format(\'woff2\');')
    expect(css).not.toContain('.woff\'')
    expect(css).not.toMatch(/https?:/)
  })

  it('refuses a rule it does not understand instead of emitting a broken face', () => {
    expect(() => parseFontsourceCss('@font-face { font-family: X; src: url(x.ttf); }')).toThrow(/unexpected @font-face/)
  })
})

describe('generated tree', () => {
  let out: string
  let tmp: string
  let summary: GeneratedSummary

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vendor-assets-'))
    out = join(tmp, 'vendor')
    summary = generateVendorAssets(ROOT, out)
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const fileFor = (url: string) => join(out, url.slice(VENDOR_BASE.length))

  it('contains every SRI-locked file byte-identical', () => {
    for (const file of lockedVendorFiles()) {
      expect(sriOf(readFileSync(fileFor(file.url))), file.url).toBe(file.sri)
    }
  })

  it('ships the woff2 fonts KaTeX\'s stylesheet asks for first', () => {
    const css = readFileSync(fileFor(KATEX_CSS_URL), 'utf8')
    const woff2 = [...css.matchAll(/url\((fonts\/[\w-]+\.woff2)\)/g)].map(m => m[1] ?? '')
    expect(woff2.length).toBeGreaterThan(10)
    const dir = join(fileFor(KATEX_CSS_URL), '..')
    for (const f of woff2) expect(existsSync(join(dir, f)), f).toBe(true)
  })

  it('every font stylesheet points at woff2 files that exist, next to their licence', () => {
    for (const font of SELF_HOSTED_FONTS) {
      const url = fontStylesheetUrl(font.name) ?? ''
      const css = readFileSync(fileFor(url), 'utf8')
      const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map(m => m[1] ?? '')
      expect(urls.length, font.name).toBeGreaterThan(0)
      for (const u of urls) {
        // `<slug>@<version>/…`; a bundled family's version may carry a `-<n>` subset revision.
        expect(u, font.name).toMatch(/^[\w-]+@\d+(?:\.\d+)+(?:-\d+)?\/[\w-]+\.woff2$/)
        expect(existsSync(join(out, 'fonts', u)), u).toBe(true)
      }
      expect(css).toMatch(/font-style: italic;/)
      const dir = urls[0]?.split('/')[0] ?? ''
      expect(existsSync(join(out, 'fonts', dir, 'LICENSE.txt')), font.name).toBe(true)
      expect(summary.fontBytes[font.name], font.name).toBeGreaterThan(0)
      // Static cuts only: one weight per face, never a variable range.
      for (const m of css.matchAll(/font-weight: ([^;]+);/g)) expect(m[1], font.name).toMatch(/^\d00$/)
      for (const m of css.matchAll(/src: url\('[^']+'\)/g)) expect(m[0], font.name).not.toMatch(/-(?:wght|opsz)-/)
    }
  })

  it('serves the app shell\'s variable cuts from their own stylesheet', () => {
    const appCss = readFileSync(join(ROOT, 'app', 'assets', 'css', 'main.css'), 'utf8')
    for (const font of SELF_HOSTED_FONTS.filter(f => f.ui)) {
      const css = readFileSync(join(out, 'fonts', `${font.slug}.variable.css`), 'utf8')
      // Its own family name: under the theme's name it would join the
      // document's static faces on the server render page (an app page)
      // and win the matching, the PDF would embed it as Type 3 again.
      expect(css, font.name).toContain(`font-family: '${font.name} Variable';`)
      expect(css, font.name).not.toContain(`font-family: '${font.name}';`)
      expect(appCss, font.name).toContain(`'${font.name} Variable', '${font.name}'`)
      const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map(m => m[1] ?? '')
      expect(urls.length, font.name).toBeGreaterThan(0)
      for (const u of urls) {
        expect(u, font.name).toMatch(new RegExp(`^${font.slug}-variable@[\\d.]+/[\\w-]+-(?:wght|opsz)-(?:normal|italic)\\.woff2$`))
        expect(existsSync(join(out, 'fonts', u)), u).toBe(true)
      }
      expect(existsSync(join(out, 'fonts', urls[0]?.split('/')[0] ?? '', 'LICENSE.txt')), font.name).toBe(true)
    }
  })

  it('covers Greek in the bundled TeX families (own glyphs or a CM Unicode companion)', () => {
    for (const slug of ['tex-gyre-termes', 'tex-gyre-heros']) {
      expect(readFileSync(join(out, 'fonts', `${slug}.css`), 'utf8'), slug).toContain('U+0370-03FF')
    }
    for (const slug of ['latin-modern-roman', 'latin-modern-mono']) {
      const css = readFileSync(join(out, 'fonts', `${slug}.css`), 'utf8')
      const greek = css.split('@font-face').filter(rule => rule.includes('cmu-greek-'))
      expect(greek.length, slug).toBeGreaterThanOrEqual(3)
      for (const rule of greek) expect(rule, slug).toContain('unicode-range: U+0370-03FF, U+1F00-1FFF;')
      // The Latin Modern files themselves don't claim Greek, so every Greek letter comes from one design.
      for (const rule of css.split('@font-face').filter(r => r.includes('/lm'))) expect(rule, slug).not.toContain('U+0370')
      expect(css, slug).toContain('LICENSE-CMU.txt')
      const dir = [...css.matchAll(/url\('([^'/]+)\//g)][0]?.[1] ?? ''
      expect(existsSync(join(out, 'fonts', dir, 'LICENSE-CMU.txt')), slug).toBe(true)
    }
  })

  it('ships each package licence', () => {
    for (const [pkg, version] of Object.entries(PINNED_VERSIONS)) {
      expect(existsSync(join(out, `${pkg}@${version}`, 'LICENSE.txt')), pkg).toBe(true)
    }
  })
})

describe('vendorAssetHeaders', () => {
  it('opens /vendor/ to the opaque-origin iframes and caches versioned files forever', () => {
    expect(vendorAssetHeaders('/vendor/mermaid@12.3.0/mermaid.min.js')).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable'
    })
    expect(vendorAssetHeaders('/vendor/fonts/inter@5.3.0/inter-latin-wght-normal.woff2')?.['Cache-Control']).toContain('immutable')
  })

  it('revalidates the unversioned per-family font stylesheets', () => {
    expect(vendorAssetHeaders('/vendor/fonts/inter.css')?.['Cache-Control']).toBe('no-cache')
    expect(vendorAssetHeaders('/vendor/fonts/inter.css?x=1')?.['Cache-Control']).toBe('no-cache')
  })

  it('leaves every other path alone', () => {
    expect(vendorAssetHeaders('/')).toBeNull()
    expect(vendorAssetHeaders('/vendorX/a.js')).toBeNull()
    expect(vendorAssetHeaders('/api/files/a/b')).toBeNull()
  })
})
