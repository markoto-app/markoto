// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { NuxtPage, WorkspaceBillingPanel } from '#components'
import { useQueryCache } from '@pinia/colada'
import type { H3Event } from 'h3'
import { DEFAULT_TIERS } from '~~/shared/config/tiers'
import { CURRENCIES, DEFAULT_PLAN_PRICES, type PlanPricesResponse } from '~~/shared/config/pricing'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import type { BillingMode } from '~~/shared/config/billingMode'
import type { UserBilling } from '~/composables/billing/useBilling'
import type { WorkspaceBillingOverview } from '~/utils/billing/workspaceBilling'
import { useAiCreditsQuery } from '~/queries/ai'
import { useUserBillingQuery } from '~/queries/billing'

// ONE rule for every billing change the client can make: when the server
// has answered, every read the change affects is fetched again AFTER that
// answer, and the card shows what the server now says, never what the
// client assumed. A card that kept its old state until a reload was a real
// bug (a switched billing period that still said "monthly").
//
// The server here applies each change AND moves something the client has
// no way to know (a new renewal date, a limit it clamps): only a view
// that re-read the server can show it. A new billing mutation gets a row
// in `MUTATIONS`; the test body stays the same.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
const { goToExternal } = vi.hoisted(() => ({ goToExternal: vi.fn() }))
mockNuxtImport('goToExternal', () => goToExternal)

// ── The server ───────────────────────────────────────────────────────

type Read = 'plan and limits' | 'AI points (personal)' | 'AI points (workspace)' | 'workspace billing'

/** Every request gets the next number; a read is fresh when its number is above the change's. */
let requests = 0
let changeAnsweredAt = 0
const lastRead = new Map<Read, number>()
function read(name: Read): void {
  lastRead.set(name, ++requests)
}

const MB = 1024 * 1024
let billing: UserBilling
let overview: WorkspaceBillingOverview
let workspacePoints = 10_000

registerEndpoint('/api/user/billing', () => {
  read('plan and limits')
  return billing
})
registerEndpoint('/api/ai/credits', (event: H3Event) => {
  const workspaceId = new URL(event.path, 'http://x').searchParams.get('workspaceId')
  read(workspaceId ? 'AI points (workspace)' : 'AI points (personal)')
  const points = workspaceId ? workspacePoints : 5000
  return { pointsRemaining: points, pointsTotal: points, planPointsRemaining: points, creditPoints: 0, plan: billing.plan, periodEnd: billing.periodEnd, attribution: workspaceId ? 'workspace' : 'user', freeAllowance: null, workspace: null }
})
registerEndpoint('/api/workspaces/ws1/billing', () => {
  read('workspace billing')
  return overview
})
const PRICES: PlanPricesResponse = { currencies: CURRENCIES, prices: DEFAULT_PLAN_PRICES, source: 'stripe' }
registerEndpoint('/api/billing/prices', () => PRICES)
registerEndpoint('/api/billing/tiers', () => DEFAULT_TIERS)
registerEndpoint('/api/user/account-status', () => null)
registerEndpoint('/api/user/exports', () => [])

/** What the server does with a change: set per case, run before the answer goes out. */
let serverApplies: (body: Record<string, unknown>) => void = () => {}

async function change(event: H3Event, answer: (body: Record<string, unknown>) => unknown): Promise<unknown> {
  const { readBody } = await import('h3')
  const body = (await readBody<Record<string, unknown> | undefined>(event)) ?? {}
  serverApplies(body)
  changeAnsweredAt = ++requests
  return answer(body)
}
registerEndpoint('/api/billing/checkout', {
  method: 'POST',
  handler: event => change(event, body => ({ updated: true, plan: 'pro', interval: body.interval ?? 'month' }))
})
registerEndpoint('/api/workspaces/ws1/billing/checkout', {
  method: 'POST',
  handler: event => change(event, () => ({ updated: true, plan: overview.subscription?.plan, interval: overview.subscription?.interval }))
})
registerEndpoint('/api/workspaces/ws1/billing/seats', {
  method: 'POST',
  handler: event => change(event, body => ({ seats: body.seats }))
})
registerEndpoint('/api/workspaces/ws1/billing/members/2', {
  method: 'PATCH',
  handler: event => change(event, () => ({ ok: true }))
})

// ── The views ────────────────────────────────────────────────────────

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const Route = defineComponent({ render: () => h(NuxtPage) })

/** What the rest of the app keeps on screen: the plan badge and both AI point meters. */
const AppChrome = defineComponent({
  setup() {
    useUserBillingQuery()
    useAiCreditsQuery(null)
    useAiCreditsQuery('ws1')
    return () => h('div')
  }
})

async function mount(surface: 'profile' | 'pricing' | 'workspace billing tab'): Promise<Wrapper> {
  mounted.push(await mountSuspended(AppChrome))
  const wrapper = surface === 'workspace billing tab'
    ? await mountSuspended(WorkspaceBillingPanel, { props: { workspaceId: 'ws1' } })
    : await mountSuspended(Route, { route: surface === 'profile' ? '/settings/profile' : '/pricing' })
  mounted.push(wrapper)
  await flushPromises()
  if (surface === 'workspace billing tab') {
    await vi.waitFor(() => expect(wrapper.find('[data-testid="workspace-billing-subscription"]').exists()).toBe(true))
  }
  return wrapper
}

async function tick(wrapper: Wrapper, checkbox: string): Promise<void> {
  await wrapper.get(`[data-testid="${checkbox}"] [role="checkbox"]`).trigger('click')
  await flushPromises()
}

async function click(wrapper: Wrapper, button: string): Promise<void> {
  await wrapper.get(`[data-testid="${button}"]`).trigger('click')
  await flushPromises()
}

const text = (wrapper: Wrapper, testid: string) => wrapper.find(`[data-testid="${testid}"]`).text()

// ── Every billing mutation the client has ────────────────────────────

interface Mutation {
  name: string
  surface: 'profile' | 'pricing' | 'workspace billing tab'
  /** The server's side of the change, including what only it knows. */
  server: (body: Record<string, unknown>) => void
  /** The user's clicks. */
  act: (wrapper: Wrapper) => Promise<void>
  /** The reads the change makes stale. */
  rereads: Read[]
  /** The card, and what it has to say once the server's state is shown. */
  shows: (wrapper: Wrapper) => void
}

const PERSONAL: Read[] = ['plan and limits', 'AI points (personal)']
const WORKSPACE: Read[] = ['workspace billing', 'plan and limits', 'AI points (personal)', 'AI points (workspace)']
const NEW_RENEWAL = '2031-03-05T00:00:00.000Z'

const MUTATIONS: Mutation[] = [
  {
    name: 'Pro: switch between monthly and annual billing (profile, useSwitchProInterval)',
    surface: 'profile',
    server: (body) => {
      billing = { ...billing, interval: body.interval as 'month' | 'year', periodEnd: NEW_RENEWAL }
    },
    act: async (wrapper) => {
      await tick(wrapper, 'profile-switch-paid-terms')
      await click(wrapper, 'profile-switch-interval')
    },
    rereads: PERSONAL,
    shows: (wrapper) => {
      expect(text(wrapper, 'profile-plan')).toContain('Pro · annual')
      expect(text(wrapper, 'profile-plan-renews')).toContain('2031')
    }
  },
  {
    name: 'Pro: a purchase the server applies in place (pricing page)',
    surface: 'pricing',
    server: () => {
      billing = { ...billing, plan: 'pro', interval: 'month', periodEnd: NEW_RENEWAL }
    },
    act: async (wrapper) => {
      await tick(wrapper, 'pricing-paid-terms-pro')
      await click(wrapper, 'pricing-buy-pro')
    },
    rereads: PERSONAL,
    shows: (wrapper) => {
      expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-current-plan-badge"]').exists()).toBe(true)
    }
  },
  {
    name: 'workspace: switch the plan',
    surface: 'workspace billing tab',
    server: (body) => {
      overview.subscription = { ...overview.subscription!, plan: body.plan as 'team' | 'business', validUntil: NEW_RENEWAL }
    },
    act: async (wrapper) => {
      await tick(wrapper, 'workspace-billing-switch-paid-terms')
      await click(wrapper, 'workspace-billing-switch-plan')
    },
    rereads: WORKSPACE,
    shows: (wrapper) => {
      expect(text(wrapper, 'workspace-billing-plan-name')).toContain('Business')
      expect(text(wrapper, 'workspace-billing-renews')).toContain('2031')
    }
  },
  {
    name: 'workspace: switch between monthly and annual billing',
    surface: 'workspace billing tab',
    server: (body) => {
      overview.subscription = { ...overview.subscription!, interval: body.interval as 'month' | 'year', validUntil: NEW_RENEWAL }
    },
    act: async (wrapper) => {
      await tick(wrapper, 'workspace-billing-switch-paid-terms')
      await click(wrapper, 'workspace-billing-switch-interval')
    },
    rereads: WORKSPACE,
    shows: (wrapper) => {
      expect(text(wrapper, 'workspace-billing-plan-name')).toContain('annual')
      expect(text(wrapper, 'workspace-billing-renews')).toContain('2031')
    }
  },
  {
    name: 'workspace: change the seats',
    surface: 'workspace billing tab',
    server: (body) => {
      // More seats, and the pooled budget that follows from them.
      overview.subscription = { ...overview.subscription!, seats: body.seats as number }
      overview.pool = { ...overview.pool!, aiBudgetUsd: 42.5 }
    },
    act: async (wrapper) => {
      Reflect.set(wrapper.vm, 'seatsDraft', 9)
      await flushPromises()
      await click(wrapper, 'workspace-billing-save-seats')
    },
    rereads: WORKSPACE,
    shows: (wrapper) => {
      expect(text(wrapper, 'workspace-billing-subscription')).toContain('4 of 9 seats used')
      expect(text(wrapper, 'workspace-billing-team-spend')).toContain('$42.50')
    }
  },
  {
    name: 'workspace: set a member\'s AI limit',
    surface: 'workspace billing tab',
    server: () => {
      // The server stores its own figure (it clamps to the pool).
      overview.members = overview.members.map(m => m.userId === 2 ? { ...m, limitUsd: 7.5, limitIsDefault: false } : m)
      workspacePoints = 7500
    },
    act: async (wrapper) => {
      const drafts = Reflect.get(wrapper.vm, 'limitDrafts') as Record<number, { mode: string, amount: number }>
      drafts[2] = { mode: 'custom', amount: 9 }
      await flushPromises()
      await click(wrapper, 'workspace-billing-limit-save-2')
    },
    // The member's own meter inside the workspace follows the limit.
    rereads: ['workspace billing', 'AI points (workspace)'],
    shows: (wrapper) => {
      expect(text(wrapper, 'workspace-billing-member-2')).toContain('limit $7.50')
    }
  }
]

beforeEach(() => {
  requests = 0
  changeAnsweredAt = 0
  lastRead.clear()
  workspacePoints = 10_000
  serverApplies = () => {}
  useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false }
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, loginProviders: ['github'] }
  billing = {
    plan: 'pro',
    interval: 'month',
    cancelAt: null,
    periodStart: '2027-01-01T00:00:00.000Z',
    periodEnd: '2027-02-01T00:00:00.000Z',
    ownedWorkspaces: 0,
    workspacesOwnedLimit: 10,
    knowledgeFilesUsed: 0,
    knowledgeFilesLimit: 100,
    knowledgeBytesUsed: 0,
    knowledgeBytesPerUserLimit: 2048 * MB,
    imageBytesUsed: 0,
    imageBytesPerUserLimit: 2048 * MB,
    credits: { usableUsd: 0, usedThisMonthUsd: 0, grants: [] },
    coveringWorkspaces: []
  }
  overview = {
    billingEnabled: true,
    minSeats: 3,
    seatsUsed: 4,
    isBillingAdmin: true,
    subscription: {
      plan: 'team', seats: 5, status: 'active', entitled: true, interval: 'month', currency: 'eur',
      currentPeriodStart: '2027-01-01T00:00:00Z', validUntil: '2027-02-01T00:00:00Z', cancelAt: null, billingAdminId: 1
    },
    pool: { aiBudgetUsd: 25, aiSpendUsd: 3.2, defaultMemberLimitUsd: 10, knowledgeBytes: 25 * 2 ** 30, imageBytes: 50 * 2 ** 30, resetsAt: null },
    credits: null,
    members: [
      { userId: 1, name: 'Ada', role: 'admin', limitUsd: 10, limitIsDefault: true, unlimited: false, spendUsd: 1.5 },
      { userId: 2, name: 'Ben', role: 'editor', limitUsd: 10, limitIsDefault: true, unlimited: false, spendUsd: 1.7 }
    ]
  }
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  const cache = useQueryCache()
  for (const entry of cache.getEntries()) cache.remove(entry)
})

describe('a billing change is shown from the server, never from a stale read', () => {
  it.each(MUTATIONS)('$name', async (mutation) => {
    // The pricing-page purchase starts from a Free account.
    if (mutation.surface === 'pricing') billing = { ...billing, plan: 'free', interval: null }
    const wrapper = await mount(mutation.surface)
    await vi.waitFor(() => {
      for (const name of mutation.rereads) expect(lastRead.has(name), `${name} is on screen`).toBe(true)
    })
    serverApplies = mutation.server

    await mutation.act(wrapper)

    await vi.waitFor(() => {
      expect(changeAnsweredAt, 'the change reached the server').toBeGreaterThan(0)
      for (const name of mutation.rereads) {
        expect(lastRead.get(name), `"${name}" is read again after the server answered`).toBeGreaterThan(changeAnsweredAt)
      }
    })
    await vi.waitFor(() => mutation.shows(wrapper))
    // In place: nothing sent the user away to Stripe.
    expect(goToExternal).not.toHaveBeenCalled()
  })
})
