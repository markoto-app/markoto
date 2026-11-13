// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { AuthLoginButtons, WorkspaceSsoPanel } from '#components'
import type { H3Event } from 'h3'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// Per-workspace single sign-on UI: the admin panel and the
// "Sign in with your organisation" entry on the sign-in buttons.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []

async function readJson(event: H3Event) {
  const { readBody } = await import('h3')
  return readBody(event)
}

const ACTIVE_VIEW = {
  available: true,
  connection: {
    id: 'c1',
    protocol: 'oidc',
    status: 'active',
    defaultRole: 'editor',
    oidcIssuer: 'https://login.acme.test',
    oidcClientId: 'markoto',
    hasClientSecret: true,
    samlIdpEntityId: null,
    samlSsoUrl: null,
    samlCertificate: null,
    hasScimToken: false,
    activatedAt: '2026-11-09T10:00:00.000Z',
    sp: {
      loginUrl: 'https://md.test/auth/sso/c1',
      callbackUrl: 'https://md.test/auth/sso/c1/callback',
      entityId: 'https://md.test/auth/sso/c1/metadata',
      acsUrl: 'https://md.test/auth/sso/c1/acs',
      metadataUrl: 'https://md.test/auth/sso/c1/metadata',
      scimBaseUrl: 'https://md.test/scim/v2'
    }
  },
  domains: [{ id: 1, domain: 'acme.test', verified: false, txtName: 'acme.test', txtValue: 'markoto-verification=abc' }]
}

let view: unknown
const puts: unknown[] = []
const discoverBodies: unknown[] = []
// One handler for the path: two method-specific registrations on the same
// path don't both apply in the test runtime.
registerEndpoint('/api/workspaces/ws1/sso', async (event) => {
  if (event.method !== 'PUT') return view
  const body = await readJson(event) as Record<string, unknown>
  puts.push(body)
  return { ...ACTIVE_VIEW, connection: { ...ACTIVE_VIEW.connection, status: 'draft', oidcIssuer: body.oidcIssuer } }
})
registerEndpoint('/api/workspaces/ws1/sso/scim-token', { method: 'POST', handler: () => ({ token: 'mkscim_once', baseUrl: 'https://md.test/scim/v2' }) })
registerEndpoint('/api/auth/sso/discover', {
  method: 'POST',
  handler: async (event) => {
    discoverBodies.push(await readJson(event))
    const { createError } = await import('h3')
    throw createError({ statusCode: 404, data: { code: 'sso/no-connection' } })
  }
})

beforeEach(() => {
  view = structuredClone(ACTIVE_VIEW)
  puts.length = 0
  discoverBodies.length = 0
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})

describe('WorkspaceSsoPanel', () => {
  it('shows the status, the values for the IdP and unverified domains with their TXT record, never a secret', async () => {
    const w = await mountSuspended(WorkspaceSsoPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await flushPromises()
    expect(w.get('[data-testid="workspace-sso-status"]').text()).toBe('On')
    expect(w.find('[data-testid="workspace-sso-enforced"]').exists()).toBe(true)
    expect(w.get('[data-testid="workspace-sso-sp-callback"]').text()).toBe('https://md.test/auth/sso/c1/callback')
    expect(w.get('[data-testid="workspace-sso-domain-acme.test"]').text()).toContain('markoto-verification=abc')
    expect((w.get('input[data-testid="workspace-sso-oidc-client-secret"], [data-testid="workspace-sso-oidc-client-secret"] input').element as HTMLInputElement).value).toBe('')
  })

  it('saves without resending a kept secret; shows a new SCIM token once', async () => {
    const w = await mountSuspended(WorkspaceSsoPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await flushPromises()
    await w.get('input[data-testid="workspace-sso-oidc-issuer"], [data-testid="workspace-sso-oidc-issuer"] input').setValue('https://login.acme.test/v2')
    await w.get('[data-testid="workspace-sso-save"]').trigger('click')
    await flushPromises()
    expect(puts).toEqual([{ protocol: 'oidc', oidcIssuer: 'https://login.acme.test/v2', oidcClientId: 'markoto', defaultRole: 'editor' }])
    await vi.waitFor(() => expect(w.get('[data-testid="workspace-sso-status"]').text()).toBe('Not switched on'))

    await w.get('[data-testid="workspace-sso-scim-create"]').trigger('click')
    await vi.waitFor(() => expect(w.get('[data-testid="workspace-sso-scim-token"]').text()).toContain('mkscim_once'))
  })

  it('without the plan: a plan notice and no save', async () => {
    view = { available: false, connection: null, domains: [] }
    const w = await mountSuspended(WorkspaceSsoPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await flushPromises()
    expect(w.find('[data-testid="workspace-sso-plan-notice"]').exists()).toBe(true)
    expect(w.find('[data-testid="workspace-sso-save"]').exists()).toBe(false)
  })
})

describe('Sign in with your organisation', () => {
  function setConfig(patch: Partial<InstanceConfig>): void {
    useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, loginProviders: ['github'], ...patch }
  }

  it('is offered only where per-workspace SSO exists, and explains an unknown domain', async () => {
    setConfig({ workspaceSso: false })
    const off = await mountSuspended(AuthLoginButtons)
    mounted.push(off)
    expect(off.find('[data-testid="login-sso"]').exists()).toBe(false)

    setConfig({ workspaceSso: true })
    const w = await mountSuspended(AuthLoginButtons)
    mounted.push(w)
    await w.get('[data-testid="login-sso"]').trigger('click')
    await w.get('input[data-testid="login-sso-email"], [data-testid="login-sso-email"] input').setValue('ada@nowhere.test')
    await w.get('[data-testid="login-sso-form"]').trigger('submit')
    await flushPromises()
    expect(discoverBodies[0]).toMatchObject({ email: 'ada@nowhere.test' })
    expect(w.get('[data-testid="login-sso-error"]').text()).toContain('isn\'t set up')
  })
})
