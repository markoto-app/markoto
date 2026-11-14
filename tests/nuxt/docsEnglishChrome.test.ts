// @vitest-environment nuxt
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CommonLegalFooter } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { loadAreaMessages, useAreaI18n, useAreaLocale } from '~/composables/platform/useAreaI18n'

// The docs are English only, so the chrome around them is English too,
// whatever the UI language is; everything outside /docs keeps the UI
// language, and the visitor's language itself is never changed.

// What the docs layout does: load the English texts, then translate.
const Probe = defineComponent({
  async setup() {
    await loadAreaMessages()
    const { t } = useAreaI18n()
    const locale = useAreaLocale()
    return () => h('div', [
      h('span', { 'data-testid': 'locale' }, locale.value),
      h('span', { 'data-testid': 'search' }, t('docs.searchLabel')),
      h('span', { 'data-testid': 'next' }, t('docs.pagination.next')),
      h('span', { 'data-testid': 'toc' }, t('docs.onThisPage'))
    ])
  }
})

describe('docs area in English under a German UI', () => {
  beforeAll(async () => {
    useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, legalSurfaces: true }
    await useNuxtApp().$i18n.setLocale('de')
  })
  afterAll(async () => {
    await useNuxtApp().$i18n.setLocale('en')
  })

  it('translates docs chrome into English on a docs route', async () => {
    const wrapper = await mountSuspended(Probe, { route: '/docs/ai/overview' })
    expect(wrapper.find('[data-testid="locale"]').text()).toBe('en')
    expect(wrapper.find('[data-testid="search"]').text()).toBe('Search the docs...')
    expect(wrapper.find('[data-testid="next"]').text()).toBe('next')
    expect(wrapper.find('[data-testid="toc"]').text()).toBe('On this page')
    wrapper.unmount()
  })

  it('shows the shared footer in English on a docs route', async () => {
    const wrapper = await mountSuspended(CommonLegalFooter, { route: '/docs' })
    expect(wrapper.find('[data-testid="footer-cookie-note"]').text()).toBe('Cookies: essential only')
    wrapper.unmount()
  })

  it('leaves the UI language alone: still German, also for the same components elsewhere', async () => {
    const { locale, getLocaleCookie } = useNuxtApp().$i18n
    expect(locale.value).toBe('de')
    expect(getLocaleCookie()).toBe('de')

    const probe = await mountSuspended(Probe, { route: '/pricing' })
    expect(probe.find('[data-testid="locale"]').text()).toBe('de')
    expect(probe.find('[data-testid="next"]').text()).toBe('weiter')
    probe.unmount()

    const footer = await mountSuspended(CommonLegalFooter, { route: '/pricing' })
    expect(footer.find('[data-testid="footer-cookie-note"]').text()).not.toBe('Cookies: essential only')
    footer.unmount()
  })
})
