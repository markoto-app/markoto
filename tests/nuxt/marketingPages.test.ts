// @vitest-environment nuxt
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { CommonLegalFooter, CompareTable, Faq, FlowStrip, MarketingHeader, NuxtPage, TourClip } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { fetchMarketingPage } from '~/utils/marketingPage'

// Marketing content pages (pages/[...marketing].vue): 404 for unknown
// slugs (fetchMarketingPage → null) and off the marketing site (the
// middleware, also pinned in marketingSiteSeo.test.ts), hreflang only for
// reviewed versions, noindex for unreviewed translations. The content
// collection is faked — the route's queries are under test, not Nuxt
// Content.

interface Item { path: string, title: string, description: string, reviewed: boolean, body: { type: 'minimark', value: unknown[] }, navGroup?: string, navLabel?: string, navOrder?: number }

const content = vi.hoisted(() => ({ items: [] as Item[] }))

function item(path: string, reviewed = true): Item {
  return {
    path,
    title: 'Markdown cheat sheet',
    description: 'Markdown syntax on one page.',
    reviewed,
    body: { type: 'minimark', value: [['p', {}, 'Hello from the page body']] }
  }
}

mockNuxtImport('queryCollection', () => () => {
  let path: string | null = null
  let inPaths: string[] | null = null
  const builder = {
    path(p: string) {
      path = p
      return builder
    },
    where(_field: string, _op: string, values: string[]) {
      inPaths = values
      return builder
    },
    select() {
      return builder
    },
    async first() {
      return content.items.find(i => i.path === path) ?? null
    },
    async all() {
      return inPaths ? content.items.filter(i => inPaths?.includes(i.path)) : content.items
    }
  }
  return builder
})

const Route = defineComponent({ render: () => h(NuxtPage) })

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

async function settleHead(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 20))
}

beforeEach(() => {
  content.items = [
    item('/marketing/en/markdown-cheat-sheet'),
    item('/marketing/de/markdown-cheat-sheet', false)
  ]
})

describe('fetchMarketingPage (the catch-all route\'s lookup; null → 404)', () => {
  it('finds a page and its language versions', async () => {
    const found = await fetchMarketingPage('/markdown-cheat-sheet')
    expect(found?.target).toEqual({ locale: 'en', slug: 'markdown-cheat-sheet' })
    expect(found?.versions.map(v => v.path)).toEqual([
      '/marketing/en/markdown-cheat-sheet',
      '/marketing/de/markdown-cheat-sheet'
    ])
  })

  it('null for an unknown slug, a missing translation and paths that can never be pages', async () => {
    expect(await fetchMarketingPage('/no-such-page')).toBeNull()
    expect(await fetchMarketingPage('/fr/markdown-cheat-sheet')).toBeNull()
    expect(await fetchMarketingPage('/de')).toBeNull()
    expect(await fetchMarketingPage('/Bad_Slug')).toBeNull()
  })
})

describe('marketing catch-all route', () => {
  it('is gated by the marketing-pages middleware and never shadows app routes', () => {
    const router = useRouter()
    const catchAll = router.getRoutes().find(r => r.path.includes(':marketing'))
    expect(catchAll?.meta.middleware).toBe('marketing-pages')
    expect(catchAll?.meta.layout).toBe('marketing')
    for (const path of ['/docs/writing/markdown-reference', '/legal/privacy', '/d/abc', '/w/abc', '/settings/profile', '/pricing', '/']) {
      expect(router.resolve(path).matched.at(-1)?.path, path).not.toContain(':marketing')
    }
    expect(router.resolve('/markdown-cheat-sheet').matched.at(-1)?.path).toContain(':marketing')
  })

  it('renders an existing page with hreflang for reviewed versions only, no noindex', async () => {
    content.items.push(item('/marketing/fr/markdown-cheat-sheet'))
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app' })
    const wrapper = await mountSuspended(Route, { route: '/markdown-cheat-sheet' })
    await settleHead()
    expect(wrapper.find('[data-testid="marketing-page"]').text()).toContain('Hello from the page body')
    const alternates = [...document.head.querySelectorAll('link[rel="alternate"][hreflang]')]
      .map(l => `${l.getAttribute('hreflang')} ${l.getAttribute('href')}`)
    expect(alternates).toEqual([
      'en https://markoto.app/markdown-cheat-sheet',
      'fr https://markoto.app/fr/markdown-cheat-sheet',
      'x-default https://markoto.app/markdown-cheat-sheet'
    ])
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow, max-image-preview:large')
    expect(document.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('article')
    expect(document.head.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe('https://markoto.app/og/use-cases.jpg')
    const ld = document.head.querySelector('script[data-hid="ld-page"]')?.textContent ?? ''
    expect(ld).toContain('"@type":"BreadcrumbList"')
    expect(ld).toContain('"about":[{"@id":"https://markoto.app/#app"}]')
    wrapper.unmount()
  })

  it('an unreviewed translation renders with a notice, noindex and no hreflang', async () => {
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app' })
    const wrapper = await mountSuspended(Route, { route: '/de/markdown-cheat-sheet' })
    await settleHead()
    expect(wrapper.find('[data-testid="marketing-unreviewed"]').exists()).toBe(true)
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, follow')
    expect(document.head.querySelectorAll('link[rel="alternate"][hreflang]').length).toBe(0)
    wrapper.unmount()
  })
})

describe('::flow-strip', () => {
  it('renders the default variant as <img> with alt, width and height — no fetch, no client-only step', async () => {
    const wrapper = await mountSuspended(FlowStrip, { props: { id: 'rich-content', frames: '20' } })
    const light = wrapper.find('img.mk-flow-strip__img--light')
    expect(light.attributes('src')).toBe('/flows/rich-content/en/light-desktop/20.webp')
    expect(light.attributes('alt')?.length).toBeGreaterThan(10)
    expect(light.attributes('width')).toBe('1280')
    expect(light.attributes('height')).toBe('800')
    // Dark twin for the CSS colour-mode swap, hidden from assistive tech.
    const dark = wrapper.find('img.mk-flow-strip__img--dark')
    expect(dark.attributes('src')).toBe('/flows/rich-content/en/dark-desktop/20.webp')
    expect(dark.attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('figcaption').text()).toBe(light.attributes('alt'))
    wrapper.unmount()
  })

  it('the other content blocks render their props', async () => {
    const faq = await mountSuspended(Faq, { props: { items: [{ q: 'Is it free?', a: 'Yes.' }], jsonLd: true } })
    await settleHead()
    expect(faq.find('summary').text()).toBe('Is it free?')
    expect(document.head.querySelector('script[data-hid="ld-faq"]')?.textContent).toContain('"FAQPage"')
    faq.unmount()

    const table = await mountSuspended(CompareTable, {
      props: { columns: ['markoto', 'Other'], rows: [{ label: 'Paged PDF', values: [true, 'partial'] }, { label: 'Price', values: ['Free', '$5'] }] }
    })
    expect(table.findAll('tbody tr')[0]?.text()).toContain('Yes')
    expect(table.findAll('tbody tr')[0]?.text()).toContain('Partly')
    expect(table.findAll('tbody tr')[1]?.text()).toContain('$5')
    table.unmount()

    const clip = await mountSuspended(TourClip, { props: { scene: 'themes' } })
    const poster = clip.find('.mk-tour-clip__mode--light img')
    expect(poster.attributes('src')).toMatch(/^\/tour\/light\/themes\//)
    expect(poster.attributes('alt')?.length).toBeGreaterThan(10)
    clip.unmount()
  })

  it('a page caption replaces the step text of a single shot, not of several', async () => {
    const single = await mountSuspended(FlowStrip, { props: { id: 'rich-content', frames: '20', caption: 'A pie chart.' } })
    expect(single.find('img.mk-flow-strip__img--light').attributes('alt')).toBe('A pie chart.')
    expect(single.find('figcaption').text()).toBe('A pie chart.')
    single.unmount()

    const several = await mountSuspended(FlowStrip, { props: { id: 'rich-content', limit: 2, caption: 'A pie chart.' } })
    const captions = several.findAll('figcaption').map(f => f.text())
    expect(captions.length).toBe(2)
    expect(captions).not.toContain('A pie chart.')
    several.unmount()
  })

  it('`captions` gives every shot its own caption and alt text, in order', async () => {
    const wrapper = await mountSuspended(FlowStrip, { props: { id: 'rich-content', frames: '10,20', captions: ['A tip alert.', 'Code, math and a chart.'] } })
    expect(wrapper.findAll('figcaption').map(f => f.text())).toEqual(['A tip alert.', 'Code, math and a chart.'])
    expect(wrapper.findAll('img.mk-flow-strip__img--light').map(i => i.attributes('alt'))).toEqual(['A tip alert.', 'Code, math and a chart.'])
    wrapper.unmount()
  })

  it('renders nothing for an unknown flow', async () => {
    const wrapper = await mountSuspended(FlowStrip, { props: { id: 'no-such-flow' } })
    expect(wrapper.find('img').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('Self-host link', () => {
  it('points at the self-hosting page on the marketing site, in the header and the footer', async () => {
    setConfig({ marketingSite: true })
    const header = await mountSuspended(MarketingHeader)
    expect(header.find('[data-testid="header-self-host-link"]').attributes('href')).toBe('/self-hosted-markdown-editor')
    header.unmount()
    const footer = await mountSuspended(CommonLegalFooter)
    expect(footer.find('[data-testid="footer-self-host-link"]').attributes('href')).toBe('/self-hosted-markdown-editor')
    footer.unmount()
  })
})

describe('Templates link', () => {
  it('the header links no template page; the footer lists every one in its own column', async () => {
    setConfig({ marketingSite: true })
    content.items = [
      { ...item('/marketing/en/templates/resume'), navGroup: 'templates', navLabel: 'Resume template', navOrder: 20 },
      { ...item('/marketing/en/templates'), navGroup: 'templates', navLabel: 'All templates', navOrder: 0 },
      { ...item('/marketing/en/templates/report'), navGroup: 'templates', navLabel: 'Report template', navOrder: 10 }
    ]
    clearNuxtData('marketing:nav')
    const footer = await mountSuspended(CommonLegalFooter)
    await vi.waitFor(() => expect(footer.find('[data-testid="footer-col-templates"]').exists()).toBe(true))
    const hrefs = footer.find('[data-testid="footer-col-templates"]').findAll('a').map(a => a.attributes('href'))
    expect(hrefs).toEqual(expect.arrayContaining(['/templates', '/templates/report', '/templates/resume']))
    expect(hrefs.indexOf('/templates')).toBeLessThan(hrefs.indexOf('/templates/report'))
    expect(hrefs.indexOf('/templates/report')).toBeLessThan(hrefs.indexOf('/templates/resume'))
    footer.unmount()
    // The header stays short: Pricing, Self-host, Docs — no content pages.
    const header = await mountSuspended(MarketingHeader)
    const headerHrefs = header.findAll('a').map(a => a.attributes('href'))
    expect(headerHrefs.filter(h => h?.startsWith('/templates'))).toEqual([])
    expect(header.find('[data-testid="header-docs-link"]').attributes('href')).toBe('/docs')
    header.unmount()
    clearNuxtData('marketing:nav')
  })
})

describe('Use cases menu in another UI language', () => {
  it('links a reviewed translation under its own label, an unreviewed one not at all', async () => {
    setConfig({ marketingSite: true })
    content.items = [
      { ...item('/marketing/en/markdown-to-pdf'), navGroup: 'use-cases', navLabel: 'Markdown to PDF', navOrder: 10 },
      { ...item('/marketing/de/markdown-to-pdf'), navLabel: 'Markdown in PDF' },
      { ...item('/marketing/en/markdown-cheat-sheet'), navGroup: 'use-cases', navLabel: 'Markdown cheat sheet', navOrder: 90 },
      { ...item('/marketing/de/markdown-cheat-sheet', false), navLabel: 'Markdown-Spickzettel' }
    ]
    clearNuxtData('marketing:nav')
    const i18n = useNuxtApp().$i18n
    const before = i18n.locale.value
    await i18n.loadLocaleMessages('de')
    i18n.locale.value = 'de'
    try {
      const footer = await mountSuspended(CommonLegalFooter)
      await vi.waitFor(() => expect(footer.find('a[href="/de/markdown-to-pdf"]').exists()).toBe(true))
      expect(footer.find('a[href="/de/markdown-to-pdf"]').text()).toBe('Markdown in PDF')
      expect(footer.find('a[href="/markdown-cheat-sheet"]').text()).toBe('Markdown cheat sheet')
      expect(footer.find('a[href="/de/markdown-cheat-sheet"]').exists()).toBe(false)
      footer.unmount()
    } finally {
      i18n.locale.value = before
      clearNuxtData('marketing:nav')
    }
  })
})
