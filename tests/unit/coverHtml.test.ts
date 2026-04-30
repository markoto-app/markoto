import { describe, expect, test } from 'vitest'
import { buildCoverHtml } from '../../app/utils/coverHtml'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import type { DocTheme } from '../../shared/types/theme'

/**
 * `buildCoverHtml` builds the prepended cover-page HTML. It reads
 * `theme.cover.*` and `theme.brand.*` and emits a `<section>` block
 * suitable for paged.js's named-page assignment. We assert structure
 * + content + edge-case skip conditions.
 */

const baseTheme = defaultTheme // markoto: cover.enabled=true, layout='centered', showTitle/Date true, others false

describe('buildCoverHtml — when disabled', () => {
  test('returns empty string', () => {
    const off: DocTheme = { ...baseTheme, cover: { ...baseTheme.cover, enabled: false } }
    expect(buildCoverHtml(off, 'Title', '2026-04-29')).toBe('')
  })
})

describe('buildCoverHtml — markoto default (editorial, logo + title + date)', () => {
  test('emits <section class="markoto-cover">…</section>', () => {
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).toMatch(/^<section class="markoto-cover">/)
    expect(out).toMatch(/<\/section>$/)
  })
  test('renders the title in <h1 class="markoto-cover-title">', () => {
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).toContain('<h1 class="markoto-cover-title">My Document</h1>')
  })
  test('renders the date in markoto-cover-meta + markoto-cover-date', () => {
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).toContain('<div class="markoto-cover-meta">')
    expect(out).toContain('<div class="markoto-cover-date">2026-04-29</div>')
  })
  test('does NOT render subtitle (showSubtitle is false by default)', () => {
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).not.toContain('markoto-cover-subtitle')
  })
  test('does NOT render authors (showAuthors is false by default)', () => {
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).not.toContain('markoto-cover-author')
  })
  test('renders the markoto wordmark logo by default', () => {
    // Default markoto theme pre-fills `brand.logoUrl` with the public
    // wordmark asset and `cover.showLogo = true` so every new doc
    // opens with the brand mark on its cover.
    const out = buildCoverHtml(baseTheme, 'My Document', '2026-04-29')
    expect(out).toContain('markoto-cover-logo')
    expect(out).toContain('/markoto-logos/primary-lockup-light.svg')
  })
  test('omits logo when showLogo is toggled off', () => {
    const t: DocTheme = { ...baseTheme, cover: { ...baseTheme.cover, showLogo: false } }
    const out = buildCoverHtml(t, 'My Document', '2026-04-29')
    expect(out).not.toContain('markoto-cover-logo')
  })
  test('omits logo when brand.logoUrl is empty', () => {
    const t: DocTheme = { ...baseTheme, brand: { ...baseTheme.brand, logoUrl: '' } }
    const out = buildCoverHtml(t, 'My Document', '2026-04-29')
    expect(out).not.toContain('markoto-cover-logo')
  })
})

describe('buildCoverHtml — multi-author collaboration', () => {
  test('renders each author on its own line in document order', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: {
        ...baseTheme.cover,
        showAuthors: true,
        authors: ['Alice Chen', 'Bob Patel', 'Charlie Liu']
      }
    }
    const out = buildCoverHtml(t, 'Title', '2026-04-29')
    expect(out).toContain('<div class="markoto-cover-author">Alice Chen</div>')
    expect(out).toContain('<div class="markoto-cover-author">Bob Patel</div>')
    expect(out).toContain('<div class="markoto-cover-author">Charlie Liu</div>')
    // Order preservation
    const aliceIdx = out.indexOf('Alice Chen')
    const bobIdx = out.indexOf('Bob Patel')
    const charlieIdx = out.indexOf('Charlie Liu')
    expect(aliceIdx).toBeLessThan(bobIdx)
    expect(bobIdx).toBeLessThan(charlieIdx)
  })
  test('skips empty / whitespace-only author entries', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: {
        ...baseTheme.cover,
        showAuthors: true,
        authors: ['Alice', '', '   ', 'Bob']
      }
    }
    const out = buildCoverHtml(t, 'Title', '2026-04-29')
    expect(out).toContain('Alice')
    expect(out).toContain('Bob')
    expect(out).not.toMatch(/markoto-cover-author">[\s]*<\//)
  })
  test('trims surrounding whitespace from author names', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showAuthors: true, authors: ['  Alice  '] }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .toContain('<div class="markoto-cover-author">Alice</div>')
  })
})

describe('buildCoverHtml — subtitle + logo', () => {
  test('renders subtitle when showSubtitle + non-empty subtitle text', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showSubtitle: true, subtitle: 'A field guide for collaborators' }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .toContain('<div class="markoto-cover-subtitle">A field guide for collaborators</div>')
  })
  test('skips subtitle div when subtitle text is empty even with toggle on', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showSubtitle: true, subtitle: '' }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .not.toContain('markoto-cover-subtitle')
  })
  test('renders logo when showLogo + brand.logoUrl set', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showLogo: true },
      brand: { logoUrl: '/api/files/abc/logo.png', logoHeight: 48 }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .toContain('<img class="markoto-cover-logo" src="/api/files/abc/logo.png" alt="">')
  })
  test('skips logo when toggle on but URL empty (avoid broken image)', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showLogo: true },
      brand: { logoUrl: '', logoHeight: 48 }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29')).not.toContain('markoto-cover-logo')
  })
})

describe('buildCoverHtml — HTML escaping (XSS defense)', () => {
  test('escapes < > & in the title', () => {
    const out = buildCoverHtml(baseTheme, '<script>alert("x")</script>', '2026-04-29')
    expect(out).toContain('&lt;script&gt;alert("x")&lt;/script&gt;')
    expect(out).not.toContain('<script>alert')
  })
  test('escapes < > & in subtitle', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showSubtitle: true, subtitle: '<img onerror="x">' }
    }
    const out = buildCoverHtml(t, 'T', '2026-04-29')
    expect(out).toContain('&lt;img onerror="x"&gt;')
  })
  test('escapes & in author names', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showAuthors: true, authors: ['Alice & Bob'] }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .toContain('Alice &amp; Bob')
  })
  test('escapes < > & in logo URL', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showLogo: true },
      brand: { logoUrl: '/x"><script>', logoHeight: 48 }
    }
    expect(buildCoverHtml(t, 'T', '2026-04-29'))
      .toContain('src="/x"&gt;&lt;script&gt;')
  })
})

describe('buildCoverHtml — element ordering', () => {
  test('logo → title → subtitle → meta(authors then date)', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: {
        ...baseTheme.cover,
        showSubtitle: true,
        subtitle: 'sub',
        showLogo: true,
        showAuthors: true,
        authors: ['A']
      },
      brand: { logoUrl: '/logo.png', logoHeight: 48 }
    }
    const out = buildCoverHtml(t, 'TITLE', '2026-04-29')
    const iLogo = out.indexOf('cover-logo')
    const iTitle = out.indexOf('cover-title')
    const iSubtitle = out.indexOf('cover-subtitle')
    const iMeta = out.indexOf('cover-meta')
    expect(iLogo).toBeGreaterThan(-1)
    expect(iLogo).toBeLessThan(iTitle)
    expect(iTitle).toBeLessThan(iSubtitle)
    expect(iSubtitle).toBeLessThan(iMeta)
  })
  test('authors come BEFORE date inside meta block', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: { ...baseTheme.cover, showAuthors: true, authors: ['Alice'] }
    }
    const out = buildCoverHtml(t, 'T', '2026-04-29')
    const iAuthor = out.indexOf('cover-author')
    const iDate = out.indexOf('cover-date')
    expect(iAuthor).toBeGreaterThan(-1)
    expect(iAuthor).toBeLessThan(iDate)
  })
})

describe('buildCoverHtml — never emits <p> tags', () => {
  test('cover HTML uses <h1>/<div>/<img>/<section> only — so the dropcap-wrap regex skips past it', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: {
        ...baseTheme.cover,
        showSubtitle: true,
        subtitle: 'sub',
        showAuthors: true,
        authors: ['A', 'B'],
        showLogo: true
      },
      brand: { logoUrl: '/logo.png', logoHeight: 48 }
    }
    const out = buildCoverHtml(t, 'T', '2026-04-29')
    expect(out).not.toMatch(/<p[\s>]/)
  })
})

describe('buildCoverHtml — empty values are skipped, not rendered as empty tags', () => {
  test('empty title with showTitle=true → no h1', () => {
    expect(buildCoverHtml(baseTheme, '', '2026-04-29')).not.toContain('<h1')
  })
  test('empty date with showDate=true → no date div', () => {
    const out = buildCoverHtml(baseTheme, 'T', '')
    expect(out).not.toContain('cover-date')
  })
  test('all-empty values + all toggles on → empty <section>', () => {
    const t: DocTheme = {
      ...baseTheme,
      cover: {
        ...baseTheme.cover,
        showTitle: true,
        showSubtitle: true,
        subtitle: '',
        showDate: true,
        showAuthors: true,
        authors: ['', '   '],
        showLogo: true
      },
      brand: { logoUrl: '', logoHeight: 48 }
    }
    expect(buildCoverHtml(t, '', '')).toBe('<section class="markoto-cover"></section>')
  })
})
