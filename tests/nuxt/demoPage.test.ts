// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { NuxtPage } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { SOURCE_REPO_URL } from '~~/shared/config/links'
import { DEMO_VIDEO } from '~~/shared/media/demoVideo'
import marketingPages from '~/middleware/marketing-pages'

// /demo plays the demo video on the hosted marketing site
// (NUXT_MARKETING_SITE_ENABLED); every other instance answers 404 through
// the `marketing-pages` middleware.

// The canonical link comes from app.vue's useCanonical(); mount it here too.
const Route = defineComponent({
  setup() {
    useCanonical()
    return () => h(NuxtPage)
  }
})

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

describe('/demo', () => {
  it('plays the demo video on the marketing site', async () => {
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app', docsCanonicalBase: '' })
    const wrapper = await mountSuspended(Route, { route: '/demo' })
    const video = wrapper.find('[data-testid="demo-video"]')
    expect(video.exists()).toBe(true)
    expect(video.attributes('poster')).toBe(DEMO_VIDEO.poster)
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('playsinline')).toBeDefined()
    expect(video.attributes('preload')).toBe('metadata')
    const source = video.find('source')
    expect(source.attributes('src')).toBe(DEMO_VIDEO.src)
    expect(source.attributes('type')).toBe('video/mp4')
    const track = video.find('track')
    expect(track.attributes('kind')).toBe('captions')
    expect(track.attributes('src')).toBe(DEMO_VIDEO.captions)
    expect(wrapper.find('h1').text()).toBe('markoto in two minutes.')
    expect(wrapper.find('[data-testid="demo-home"]').attributes('href')).toBe('/')
    expect(wrapper.find('[data-testid="demo-source"]').attributes('href')).toBe(SOURCE_REPO_URL)

    await settleHead()
    expect(document.title).toContain('Demo video')
    expect(headAttr('link[rel="canonical"]', 'href')).toBe('https://markoto.app/demo')
    expect(headAttr('meta[property="og:video"]', 'content')).toBe(`https://markoto.app${DEMO_VIDEO.src}`)
    expect(headAttr('meta[property="og:video:type"]', 'content')).toBe('video/mp4')
    expect(headAttr('meta[property="og:image"]', 'content')).toMatch(/^https:\/\/markoto\.app\/og\//)
    const ld = document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? ''
    expect(ld).toContain('"VideoObject"')
    expect(ld).toContain(`"contentUrl":"https://markoto.app${DEMO_VIDEO.src}"`)
  })

  it('answers 404 when the marketing site is off (self-hosted)', () => {
    const route = useRouter().getRoutes().find(r => r.path === '/demo')
    expect(route?.meta.middleware).toBe('marketing-pages')
    expect(route?.meta.layout).toBe('marketing')
    setConfig({ marketingSite: false })
    // The middleware reads only the instance config, not the route.
    const current = useRoute()
    let status: unknown
    try {
      marketingPages(current, current)
    } catch (err) {
      status = typeof err === 'object' && err !== null ? Reflect.get(err, 'statusCode') : undefined
    }
    expect(status).toBe(404)
  })
})
