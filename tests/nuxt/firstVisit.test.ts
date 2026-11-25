// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, defineComponent, h } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { AuthLoginButtons, AuthSignInModal, DocumentQuickStartDocument, PricingSignUpModal } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { DEFAULT_TEMPLATE_ID } from '~~/shared/templates'
import { rememberBrowserCreatedDoc } from '~/utils/documents/firstDocument'

// First visit: "Start writing" creates the Demo document at once for a
// first-time anonymous visitor (QuickStartDocument), every sign-in link
// returns to the page it was clicked on, and the pricing page's "Sign up"
// offers the same provider choice as the header.

const account = vi.hoisted(() => ({ loggedIn: false }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(account.loggedIn),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const toast = vi.hoisted(() => ({ add: vi.fn() }))
mockNuxtImport('useToast', () => () => toast)

const created = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>>, status: 200 }))
registerEndpoint('/api/docs', {
  method: 'POST',
  handler: async (event) => {
    const { readBody, createError } = await import('h3')
    created.bodies.push(await readBody(event))
    if (created.status !== 200) throw createError({ statusCode: created.status, message: 'nope' })
    return { docId: 'demo-doc' }
  }
})

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

beforeEach(() => {
  account.loggedIn = false
  created.bodies = []
  created.status = 200
  toast.add.mockClear()
  localStorage.clear()
  setConfig({ anonGate: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useStartWriting', () => {
  async function harness() {
    let api!: ReturnType<typeof useStartWriting>
    await mountSuspended(defineComponent({
      setup() {
        api = useStartWriting(() => Promise.resolve())
        return () => h('div')
      }
    }))
    return api
  }

  it('a first-time anonymous visitor skips the dialog, once at a time', async () => {
    const api = await harness()
    api.start()
    expect(api.quickMounted.value).toBe(true)
    expect(api.quickRun.value).toBe(1)
    expect(api.open.value).toBe(false)
    api.start()
    expect(api.quickRun.value).toBe(1)
    api.quickDone()
    expect(api.quickBusy.value).toBe(false)
  })

  it('opens the dialog for a returning visitor, a signed-in user, or a caller that asks for it', async () => {
    rememberBrowserCreatedDoc()
    const returning = await harness()
    returning.start()
    expect(returning.open.value).toBe(true)
    expect(returning.quickMounted.value).toBe(false)

    localStorage.clear()
    const explicit = await harness()
    explicit.start({ dialog: true })
    expect(explicit.open.value).toBe(true)

    account.loggedIn = true
    const signedIn = await harness()
    signedIn.start()
    expect(signedIn.open.value).toBe(true)
  })
})

describe('QuickStartDocument', () => {
  it('creates the Demo document in the visitor\'s language and remembers it', async () => {
    const wrapper = await mountSuspended(DocumentQuickStartDocument, { props: { run: 1 } })
    await vi.waitFor(() => expect(wrapper.emitted('created')).toEqual([['demo-doc']]))
    expect(created.bodies).toEqual([expect.objectContaining({ templateId: DEFAULT_TEMPLATE_ID, audience: 'casual', language: 'en' })])
    expect(wrapper.emitted('done')).toHaveLength(1)
    expect(localStorage.getItem('markoto-created-first-doc')).toBe('1')
    // Each new run creates again.
    await wrapper.setProps({ run: 2 })
    await vi.waitFor(() => expect(created.bodies).toHaveLength(2))
  })

  it('reports a failure and still finishes', async () => {
    created.status = 500
    const wrapper = await mountSuspended(DocumentQuickStartDocument, { props: { run: 1 } })
    await vi.waitFor(() => expect(wrapper.emitted('done')).toHaveLength(1))
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(toast.add).toHaveBeenCalled()
  })
})

describe('sign-in links return to the page', () => {
  beforeEach(() => {
    setConfig({ loginProviders: ['github', 'google'] })
  })

  it('LoginButtons carry the current page, or the one the caller names', async () => {
    const here = await mountSuspended(AuthLoginButtons, { route: '/pricing?interval=year' })
    expect(here.find('[data-testid="login-github"]').attributes('href')).toBe(`/auth/github?return=${encodeURIComponent('/pricing?interval=year')}`)
    const named = await mountSuspended(AuthLoginButtons, { props: { returnTo: '/d/abc' } })
    expect(named.find('[data-testid="login-google"]').attributes('href')).toBe(`/auth/google?return=${encodeURIComponent('/d/abc')}`)
  })

  it('primaryLoginPath returns to the current page', async () => {
    let path: string | null = null
    await mountSuspended(defineComponent({
      setup() {
        path = useInstanceConfig().primaryLoginPath.value
        return () => h('div')
      }
    }), { route: '/settings/ai' })
    expect(path).toBe(`/auth/github?return=${encodeURIComponent('/settings/ai')}`)
  })

  it('the sign-in dialog offers every provider, back to its page', async () => {
    const wrapper = await mountSuspended(AuthSignInModal, { props: { open: true, title: 'Sign up for Pro', returnTo: '/pricing?plan=pro' } })
    await flushPromises()
    const links = [...document.body.querySelectorAll('[data-testid="sign-in-modal"] a')].map(a => a.getAttribute('href'))
    expect(links).toEqual([
      `/auth/github?return=${encodeURIComponent('/pricing?plan=pro')}`,
      `/auth/google?return=${encodeURIComponent('/pricing?plan=pro')}`
    ])
    wrapper.unmount()
  })

  it('pricing "Sign up" keeps the chosen plan and interval, and closes by clearing the plan', async () => {
    const wrapper = await mountSuspended(PricingSignUpModal, { props: { plan: 'pro', returnTo: '/pricing?plan=pro&interval=year' } })
    await flushPromises()
    expect(document.body.textContent).toContain('Sign up for Pro')
    const github = document.body.querySelector('[data-testid="sign-in-modal"] [data-testid="login-github"]')
    expect(github?.getAttribute('href')).toBe(`/auth/github?return=${encodeURIComponent('/pricing?plan=pro&interval=year')}`)
    const modal = wrapper.findComponent(AuthSignInModal)
    modal.vm.$emit('update:open', false)
    expect(wrapper.emitted('update:plan')).toEqual([[null]])
    wrapper.unmount()
  })
})

describe('useCarryMarketingLocale', () => {
  it('keeps the language of the marketing page the visitor was reading', async () => {
    let carry!: () => void
    await mountSuspended(defineComponent({
      setup() {
        carry = useCarryMarketingLocale()
        return () => h('div')
      }
    }))
    const i18n = useNuxtApp().$i18n
    const setCookie = vi.spyOn(i18n, 'setLocaleCookie')
    const before = useMarketingLocaleBefore()
    // Off the marketing pages: nothing to carry.
    before.value = null
    carry()
    expect(setCookie).not.toHaveBeenCalled()
    // On one (the language in force before it was German): the page's language stays.
    before.value = 'de'
    carry()
    expect(setCookie).toHaveBeenCalledWith(i18n.locale.value)
    expect(before.value).toBe(i18n.locale.value)
  })
})
