import { describe, expect, it } from 'vitest'
import {
  isPagesHostRequest, pagesHostRedirect, publishPagesErrors, publishPagesSettings, publishedPageAddress, requestHostname
} from '../../server/utils/publish/pagesHost'
import { isRequestOriginAllowed } from '../../server/utils/csrf'

// Published pages on their own hostname (NUXT_PUBLISH_PAGES_HOST): the
// setting, the boot check, host matching, the app-origin redirects and
// the page addresses.

const SITE = { NUXT_SITE_URL: 'https://markoto.app' }
const TOKEN = { NUXT_PUBLISH_TRAEFIK_TOKEN: 'x'.repeat(32) }

describe('publishPagesSettings', () => {
  it('is off when unset', () => {
    expect(publishPagesSettings({ ...SITE })).toBeNull()
    expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: '  ' })).toBeNull()
  })

  it('takes a bare hostname (https) or an origin', () => {
    expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'Pages.Markoto.App.' })).toEqual({ hostname: 'pages.markoto.app', origin: 'https://pages.markoto.app' })
    expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'https://pages.markoto.app:8443' })).toEqual({ hostname: 'pages.markoto.app', origin: 'https://pages.markoto.app:8443' })
    expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'https://pages.markoto.app/' })?.origin).toBe('https://pages.markoto.app')
  })

  it('plain http only where the app itself is plain http', () => {
    expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'http://pages.markoto.app' })).toBeNull()
    expect(publishPagesSettings({ NUXT_SITE_URL: 'http://docs.lan.example.com:8080', NUXT_PUBLISH_PAGES_HOST: 'http://pages.lan.example.com:8080' }))
      .toEqual({ hostname: 'pages.lan.example.com', origin: 'http://pages.lan.example.com:8080' })
  })
})

describe('publishPagesErrors (boot)', () => {
  it('the hosted shape requires it', () => {
    expect(publishPagesErrors({ ...SITE, ...TOKEN }, true).join(' ')).toMatch(/NUXT_PUBLISH_PAGES_HOST is empty/)
    expect(publishPagesErrors({ ...SITE, ...TOKEN, NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' }, true)).toEqual([])
  })

  it('self-host may leave it empty', () => {
    expect(publishPagesErrors({ ...SITE }, false)).toEqual([])
    expect(publishPagesErrors({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' }, false)).toEqual([])
  })

  it('refuses the app host, internal and non-public names, paths, other schemes', () => {
    for (const bad of [
      'markoto.app', 'https://markoto.app', 'localhost', 'pages', 'pages.local', 'x.localhost', 'app.internal', '10.0.0.1',
      'pages.markoto.app/p', 'https://pages.markoto.app/x', 'ftp://pages.markoto.app', 'https://u:p@pages.markoto.app', 'http://pages.markoto.app',
      'pages.markoto.app`) || Host(`evil.example'
    ]) {
      expect(publishPagesErrors({ ...SITE, NUXT_PUBLISH_PAGES_HOST: bad }, false), bad).toHaveLength(1)
      expect(publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: bad }), bad).toBeNull()
    }
  })

  it('needs the site URL to link back to the app', () => {
    expect(publishPagesErrors({ NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' }, false).join(' ')).toMatch(/NUXT_SITE_URL/)
  })
})

describe('host matching', () => {
  const settings = publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' })

  it('compares the Host header without port, case or trailing dot', () => {
    expect(requestHostname('Pages.Markoto.App.:443')).toBe('pages.markoto.app')
    expect(isPagesHostRequest('pages.markoto.app', settings)).toBe(true)
    expect(isPagesHostRequest('PAGES.markoto.app:443', settings)).toBe(true)
    expect(isPagesHostRequest('markoto.app', settings)).toBe(false)
    expect(isPagesHostRequest('evil.pages.markoto.app', settings)).toBe(false)
    expect(isPagesHostRequest(undefined, settings)).toBe(false)
    expect(isPagesHostRequest('pages.markoto.app', null)).toBe(false)
  })
})

describe('app-origin redirects', () => {
  const settings = publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' })!

  it('sends /p/<slug> and a page\'s files to the pages host', () => {
    expect(pagesHostRedirect('/p/harbour-guide', settings)).toBe('https://pages.markoto.app/p/harbour-guide')
    expect(pagesHostRedirect('/p/harbour-guide/?utm=x', settings)).toBe('https://pages.markoto.app/p/harbour-guide')
    expect(pagesHostRedirect('/api/published/PageId0123456789/files/a.png', settings)).toBe('https://pages.markoto.app/api/published/PageId0123456789/files/a.png')
    expect(pagesHostRedirect('/api/published/PageId0123456789/brand/f.woff2', settings)).toBe('https://pages.markoto.app/api/published/PageId0123456789/brand/f.woff2')
  })

  it('leaves everything else (and invalid slugs) to the app', () => {
    for (const path of ['/', '/p/', '/p/A', '/p/x', '/p/a/b', '/p/%2F%2Fevil.example', '/d/abc', '/api/published/x', '/api/health', '/pricing']) {
      expect(pagesHostRedirect(path, settings), path).toBeNull()
    }
  })
})

describe('page addresses', () => {
  const settings = publishPagesSettings({ ...SITE, NUXT_PUBLISH_PAGES_HOST: 'pages.markoto.app' })

  it('on the pages host when configured, else on the instance', () => {
    expect(publishedPageAddress('harbour-guide', 'https://markoto.app', settings)).toBe('https://pages.markoto.app/p/harbour-guide')
    expect(publishedPageAddress('harbour-guide', 'https://markoto.app/', null)).toBe('https://markoto.app/p/harbour-guide')
  })
})

describe('CSRF: the pages host is not a trusted origin for the app', () => {
  it('refuses a state-changing app request whose Origin is the pages host', () => {
    expect(isRequestOriginAllowed({
      method: 'POST', path: '/api/docs', origin: 'https://pages.markoto.app', referer: undefined, secFetchSite: 'same-site', host: 'markoto.app', siteUrl: 'https://markoto.app'
    })).toBe(false)
  })
})
