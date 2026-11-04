// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import marketingPages from '~/middleware/marketing-pages'

// Hosted-only marketing surfaces (NUXT_MARKETING_SITE_ENABLED): the
// `marketing-pages` route middleware 404s elsewhere, and the SEO head
// (canonical, Open Graph) is built from the configured site URL only.

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

async function settleHead(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 20))
}

function headAttr(selector: string, attr: string): string | null {
  return document.head.querySelector(selector)?.getAttribute(attr) ?? null
}

beforeEach(() => {
  setConfig({})
})

describe('marketing-pages middleware', () => {
  it('lets the navigation through on the marketing site', () => {
    const route = useRoute()
    setConfig({ marketingSite: true })
    expect(marketingPages(route, route)).toBeUndefined()
  })

  it('answers 404 everywhere else (self-hosted default)', () => {
    const route = useRoute()
    setConfig({ marketingSite: false })
    let status: unknown
    try {
      marketingPages(route, route)
    } catch (err) {
      status = typeof err === 'object' && err !== null ? (err as Record<string, unknown>).statusCode : undefined
    }
    expect(status).toBe(404)
  })
})

describe('useMarketingSeo + useCanonical', () => {
  const Page = defineComponent({
    setup() {
      useCanonical()
      useMarketingSeo({ title: 'Pricing', description: 'What every account gets.' })
      return () => h('div')
    }
  })

  it('emits canonical, og:url and an absolute og:image from the site URL', async () => {
    setConfig({ siteUrl: 'https://markoto.app', docsCanonicalBase: '' })
    await mountSuspended(Page, { route: '/pricing?utm_source=x' })
    await settleHead()
    expect(headAttr('link[rel="canonical"]', 'href')).toBe('https://markoto.app/pricing')
    expect(headAttr('meta[property="og:url"]', 'content')).toBe('https://markoto.app/pricing')
    // /pricing gets the pricing card (shared/seo/ogImages.ts), always 1200×630 with alt text.
    expect(headAttr('meta[property="og:image"]', 'content')).toBe('https://markoto.app/og/pricing.jpg')
    expect(headAttr('meta[property="og:image:width"]', 'content')).toBe('1200')
    expect(headAttr('meta[property="og:image:height"]', 'content')).toBe('630')
    expect(headAttr('meta[property="og:image:alt"]', 'content')).toContain('pricing')
    expect(headAttr('meta[property="og:type"]', 'content')).toBe('website')
    expect(headAttr('meta[name="robots"]', 'content')).toBe('index, follow, max-image-preview:large')
    expect(headAttr('meta[property="og:title"]', 'content')).toBe('Pricing · markoto')
    expect(headAttr('meta[property="og:site_name"]', 'content')).toBe('markoto')
    expect(headAttr('meta[name="twitter:card"]', 'content')).toBe('summary_large_image')
    expect(headAttr('meta[name="description"]', 'content')).toBe('What every account gets.')
  })

  it('emits no canonical / og:url / og:image without a site URL', async () => {
    setConfig({ siteUrl: '', docsCanonicalBase: '' })
    await mountSuspended(Page, { route: '/pricing' })
    await settleHead()
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull()
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull()
    expect(headAttr('meta[name="twitter:card"]', 'content')).toBe('summary')
  })
})
