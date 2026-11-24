import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_ERRORS } from '../../../shared/api/errors'
import { resolveBillingMode } from '../../../shared/config/billingMode'
import { asUser } from '../../helpers/access'
import { stubEnv } from '../../helpers/env'

// `NUXT_BILLING_TOPUPS_ENABLED`: AI credit top-ups can be switched off
// while billing stays on (Stripe Managed Payments sells stored-value
// credits only after its written approval). Off, both top-up checkouts
// refuse before any lookup; plans are unaffected.

const getOwnTopupFacts = vi.fn(async () => null)
const getPooledWorkspace = vi.fn(async () => null)
vi.mock('../../../server/repos/userBilling', () => ({ getOwnTopupFacts }))
vi.mock('../../../server/utils/billing/workspaceBilling', () => ({ getPooledWorkspace }))

interface CapturedDef { handler: (ctx: unknown) => Promise<unknown> }
const defs: CapturedDef[] = []
vi.stubGlobal('defineApiHandler', (d: CapturedDef) => {
  defs.push(d)
  return d
})
vi.stubGlobal('allow', { user: () => ({ kind: 'user' }), workspace: (need: string) => ({ kind: 'workspace', need }) })
vi.stubGlobal('apiError', (code: keyof typeof API_ERRORS) => Object.assign(new Error(code), { statusCode: API_ERRORS[code].status, data: { code } }))

await import('../../../server/api/billing/topup.post')
await import('../../../server/api/workspaces/[wsId]/billing/topup.post')
const [personalRoute, workspaceRoute] = defs
const { assertTopupsEnabled, topupsAvailable } = await import('../../../server/utils/billing/billingMode')

const PERSONAL_CTX = { event: {}, user: { id: 7 }, self: asUser(7), body: { pack: '10', acceptPaidTerms: true } }
const WORKSPACE_CTX = { event: {}, wsId: 'ws_1', body: { pack: '10', acceptPaidTerms: true }, workspaceAccess: {} }

afterEach(() => {
  vi.unstubAllEnvs()
  getOwnTopupFacts.mockClear()
  getPooledWorkspace.mockClear()
})

describe('resolveBillingMode: topupsEnabled', () => {
  it('defaults to on (self-hosted and existing deployments unchanged)', () => {
    expect(resolveBillingMode({}).topupsEnabled).toBe(true)
    expect(resolveBillingMode({ NUXT_BILLING_ENABLED: 'true' }).topupsEnabled).toBe(true)
  })

  it('NUXT_BILLING_TOPUPS_ENABLED=false turns them off, billing stays on', () => {
    const mode = resolveBillingMode({ NUXT_BILLING_ENABLED: 'true', NUXT_BILLING_TOPUPS_ENABLED: 'false' })
    expect(mode).toMatchObject({ billingEnabled: true, topupsEnabled: false })
  })
})

describe('top-up switch on the server', () => {
  it('topupsAvailable needs billing on and top-ups not off', () => {
    stubEnv({ NUXT_BILLING_ENABLED: 'true' })
    expect(topupsAvailable()).toBe(true)
    stubEnv({ NUXT_BILLING_TOPUPS_ENABLED: 'false' })
    expect(topupsAvailable()).toBe(false)
    stubEnv({ NUXT_BILLING_ENABLED: 'false', NUXT_BILLING_TOPUPS_ENABLED: 'true' })
    expect(topupsAvailable()).toBe(false)
  })

  it('assertTopupsEnabled: 404 billing/topups-disabled when off', () => {
    stubEnv({ NUXT_BILLING_ENABLED: 'true', NUXT_BILLING_TOPUPS_ENABLED: 'false' })
    expect(() => assertTopupsEnabled()).toThrow(expect.objectContaining({ statusCode: 404, data: { code: 'billing/topups-disabled' } }))
    stubEnv({ NUXT_BILLING_TOPUPS_ENABLED: 'true' })
    expect(() => assertTopupsEnabled()).not.toThrow()
  })

  it('off: both top-up checkouts refuse before reading anything', async () => {
    stubEnv({ NUXT_BILLING_ENABLED: 'true', NUXT_BILLING_TOPUPS_ENABLED: 'false' })
    await expect(personalRoute!.handler(PERSONAL_CTX)).rejects.toMatchObject({ statusCode: 404, data: { code: 'billing/topups-disabled' } })
    await expect(workspaceRoute!.handler(WORKSPACE_CTX)).rejects.toMatchObject({ statusCode: 404, data: { code: 'billing/topups-disabled' } })
    expect(getOwnTopupFacts).not.toHaveBeenCalled()
    expect(getPooledWorkspace).not.toHaveBeenCalled()
  })

  it('on: the checkouts go on to their own checks', async () => {
    stubEnv({ NUXT_BILLING_ENABLED: 'true', NUXT_BILLING_TOPUPS_ENABLED: undefined })
    await expect(personalRoute!.handler(PERSONAL_CTX)).rejects.toMatchObject({ data: { code: 'resource/not-found' } })
    await expect(workspaceRoute!.handler(WORKSPACE_CTX)).rejects.toMatchObject({ data: { code: 'billing/no-subscription' } })
    expect(getOwnTopupFacts).toHaveBeenCalledTimes(1)
  })
})
