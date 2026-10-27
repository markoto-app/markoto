import { describe, expect, test } from 'vitest'
import {
  isThemeImageUrl,
  isThemeImageUrlForDoc,
  themeImagesForDoc,
  withThemeImagesDocId
} from '../../shared/utils/themeImages'
import { isValidTheme } from '../../shared/utils/themeValidation'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import type { DocTheme } from '../../shared/types/theme'

// Theme image URLs (cover logo, header/footer image) end up in an HTML
// attribute and a CSS `url()`. They are only ever set by the upload
// flow, so the accepted shape is narrow: empty, a bundled brand asset,
// or `/api/files/<docId>/<fileId>.<raster ext>`.

const DOC = 'docAbc123'
const OWN = `/api/files/${DOC}/AbCdEfGhIjKl.png`
const FOREIGN = '/api/files/otherDoc99/AbCdEfGhIjKl.png'

function withImages(logoUrl: string, headerUrl = '', footerUrl = ''): DocTheme {
  return {
    ...defaultTheme,
    brand: { ...defaultTheme.brand, logoUrl },
    header: { ...defaultTheme.header, imageUrl: headerUrl },
    footer: { ...defaultTheme.footer, imageUrl: footerUrl }
  }
}

describe('isThemeImageUrl (shape)', () => {
  test.each([
    '',
    OWN,
    FOREIGN,
    '/api/files/abc/logo.jpeg',
    '/markoto-logos/primary-lockup-light.svg'
  ])('accepts %s', (url) => {
    expect(isThemeImageUrl(url)).toBe(true)
  })

  test.each([
    // regression: attribute / CSS string breakout characters
    'x" onerror="alert(1)',
    String.raw`/api/files/a/b.png\'); }`,
    '/api/files/a/b.png" x="',
    'https://example.com/logo.png',
    '//example.com/logo.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '/api/files/a/b.svg',
    '/api/files/a/b.png?x=1',
    '/api/files/../b.png',
    '/markoto-logos/../secret.svg',
    ' /api/files/a/b.png'
  ])('rejects %s', (url) => {
    expect(isThemeImageUrl(url)).toBe(false)
  })

  test('rejects non-strings', () => {
    expect(isThemeImageUrl(undefined)).toBe(false)
    expect(isThemeImageUrl(42)).toBe(false)
  })
})

describe('isThemeImageUrlForDoc', () => {
  test('own uploads, bundled assets and empty pass', () => {
    expect(isThemeImageUrlForDoc(OWN, DOC)).toBe(true)
    expect(isThemeImageUrlForDoc('', DOC)).toBe(true)
    expect(isThemeImageUrlForDoc('/markoto-logos/primary-lockup-light.svg', DOC)).toBe(true)
  })
  test('another document\'s upload does not', () => {
    expect(isThemeImageUrlForDoc(FOREIGN, DOC)).toBe(false)
  })
})

describe('themeImagesForDoc', () => {
  test('keeps a theme whose images are all fine (same object)', () => {
    const t = withImages(OWN, OWN)
    const res = themeImagesForDoc(t, DOC)
    expect(res.dropped).toEqual([])
    expect(res.theme).toBe(t)
  })

  test('blanks foreign and malformed image URLs and reports the fields', () => {
    const t = withImages('x" onerror="alert(1)', FOREIGN, OWN)
    const res = themeImagesForDoc(t, DOC)
    expect(res.dropped).toEqual(['brand.logoUrl', 'header.imageUrl'])
    expect(res.theme.brand.logoUrl).toBe('')
    expect(res.theme.header.imageUrl).toBe('')
    expect(res.theme.footer.imageUrl).toBe(OWN)
    // input untouched
    expect(t.brand.logoUrl).toBe('x" onerror="alert(1)')
  })
})

describe('withThemeImagesDocId', () => {
  test('points the copy\'s images at the target document', () => {
    const src = 'srcDoc111'
    const t = withImages(`/api/files/${src}/AbCdEfGhIjKl.png`, `/api/files/${src}/b.webp`, FOREIGN)
    const out = withThemeImagesDocId(t, src, 'dstDoc222')
    expect(out.brand.logoUrl).toBe('/api/files/dstDoc222/AbCdEfGhIjKl.png')
    expect(out.header.imageUrl).toBe('/api/files/dstDoc222/b.webp')
    expect(out.footer.imageUrl).toBe(FOREIGN)
  })
})

describe('DocThemeSchema — image URL fields (regression)', () => {
  test('rejects a logo URL that is not an upload path', () => {
    expect(isValidTheme(withImages('x" onerror="alert(1)'))).toBe(false)
    expect(isValidTheme(withImages('https://example.com/a.png'))).toBe(false)
  })
  test('rejects a header/footer image URL with CSS string breakout characters', () => {
    expect(isValidTheme(withImages('', String.raw`x\'); } p { color: red } @page { x: url('`))).toBe(false)
    expect(isValidTheme(withImages('', '', 'a\'b'))).toBe(false)
  })
  test('accepts upload paths and bundled assets', () => {
    expect(isValidTheme(withImages(OWN, OWN, FOREIGN))).toBe(true)
    expect(isValidTheme(defaultTheme)).toBe(true)
  })
})
