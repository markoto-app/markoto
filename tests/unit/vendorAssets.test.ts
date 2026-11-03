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
} from '../../scripts/lib/vendorAssets'
import { FONT_STYLESHEET_BASE, SELF_HOSTED_FONTS, THEME_FONTS, fontStylesheetUrl, fontStylesheetUrls, selfHostedFont } from '../../shared/utils/themeFonts'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { VENDOR_BASE } from '../../shared/utils/vendorAssets'
import { KATEX_CSS_URL } from '../../shared/utils/katexAssets'
import { vendorAssetHeaders } from '../../server/utils/vendorAssetHeaders'

// Pins for the same-origin third-party assets (shared/utils/vendorAssets.ts):
// the version + SRI constants match the installed packages, the generator
// emits woff2-only, same-origin font stylesheets, and every font the app or
// a theme preset names is actually served.

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

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
      const spec = rootPackage.devDependencies[font.source.package]
      expect(spec, font.source.package).toMatch(/^\d+\.\d+\.\d+$/)
      expect(installedVersion(ROOT, font.source.package)).toBe(spec)
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

  it('keeps the curated 20-font picker', () => {
    expect(THEME_FONTS).toHaveLength(20)
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
        expect(u, font.name).toMatch(/^[\w-]+@\d+\.\d+\.\d+\/[\w-]+\.woff2$/)
        expect(existsSync(join(out, 'fonts', u)), u).toBe(true)
      }
      expect(css).toMatch(/font-style: italic;/)
      const dir = urls[0]?.split('/')[0] ?? ''
      expect(existsSync(join(out, 'fonts', dir, 'LICENSE.txt')), font.name).toBe(true)
      expect(summary.fontBytes[font.name], font.name).toBeGreaterThan(0)
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
    expect(vendorAssetHeaders('/vendor/mermaid@11.17.2/mermaid.min.js')).toEqual({
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
