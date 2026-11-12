import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubEnv } from '../../helpers/env'
import jwt from 'jsonwebtoken'
import { createApp, createError, createRouter, toWebHandler, type EventHandler } from 'h3'
import { z } from 'zod'
import {
  decideActivityAccess,
  decideDocDelete,
  decideFileAccess,
  decideTokenAccess,
  docStateOf,
  isEffectiveDocOwner,
  type AccessMode,
  type ActorState,
  type WorkspaceRole
} from '../../../shared/utils/documents/docPermissions'
import { hashAnonCreatorKey } from '../../../server/utils/auth/anonCreator'
import type { DocAuthzRow } from '../../../server/repos/documents'

// The handler wrapper and its access policies (server/utils/api/). Requests
// go through real h3 routing; only the repositories and session lookups are
// mocked. The document matrix compares every policy outcome with the pure
// decision functions of shared/utils/documents/docPermissions.ts, so the
// wrapper can't drift from the rules the rest of the app applies.

const m = vi.hoisted(() => ({
  user: null as { id: number, name: string } | null,
  recent: true,
  isAdmin: false,
  row: null as unknown,
  memberRole: null as string | null,
  memberRoleIgnoringSso: null as string | null,
  membership: null as string | null,
  ssoError: null as Error | null,
  rateAllowed: true,
  billingOn: true,
  planOk: true,
  idempotencyCalls: [] as string[],
  scimDeny: null as Error | null,
  rateCalls: [] as string[],
  customDomains: true,
  traefik: null as { token: string } | null
}))

vi.mock('../../../server/utils/auth/validatedSession', () => ({
  getValidatedUserSession: vi.fn(async () => m.user ? { user: m.user } : null),
  requireValidatedUserSession: vi.fn(async () => {
    if (!m.user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    return { user: m.user }
  }),
  requireRecentLogin: vi.fn(async () => {
    if (!m.user) throw createError({ statusCode: 401 })
    if (!m.recent) throw createError({ statusCode: 401, data: { code: 'auth/reauth-required' } })
    return { user: m.user }
  })
}))
vi.mock('../../../server/utils/auth/adminAccess', () => ({
  requireAdminUser: vi.fn(async () => {
    if (!m.user) throw createError({ statusCode: 401 })
    if (!m.isAdmin) throw createError({ statusCode: 403, data: { code: 'admin/forbidden' } })
    return { userId: m.user.id, name: m.user.name, email: 'a@test.local' }
  })
}))
vi.mock('../../../server/repos/documents', () => ({ getDocWithActorRole: vi.fn(async () => m.row) }))
vi.mock('../../../server/repos/workspaceMembers', () => ({
  getMemberRole: vi.fn(async () => m.memberRole),
  getMemberRoleIgnoringSso: vi.fn(async () => m.memberRoleIgnoringSso),
  getMembershipRole: vi.fn(async () => m.membership)
}))
vi.mock('../../../server/utils/sso/required', () => ({ ssoRequiredError: vi.fn(async () => m.ssoError) }))
vi.mock('../../../server/utils/sso/scim', () => ({
  requireScimConnection: vi.fn(async () => {
    if (m.scimDeny) throw m.scimDeny
    return { id: 'conn', workspaceId: 'w1' }
  })
}))
vi.mock('../../../server/utils/platform/rateLimit', () => ({
  checkRateLimit: vi.fn(async (ns: string, key: string) => {
    m.rateCalls.push(`${ns}=${key}`)
    return m.rateAllowed
  })
}))
vi.mock('../../../server/utils/platform/clientIp', () => ({ getClientRateLimitKey: vi.fn(() => '203.0.113.7') }))
vi.mock('../../../server/utils/customDomains/config', () => ({
  customDomainSettings: vi.fn(() => m.customDomains ? { target: 't' } : null),
  traefikProviderSettings: vi.fn(() => m.traefik)
}))
vi.mock('../../../server/utils/billing/billingMode', () => ({
  assertBillingEnabled: vi.fn(() => {
    if (!m.billingOn) throw createError({ statusCode: 404, data: { code: 'billing/disabled' } })
  })
}))
vi.mock('../../../server/utils/platform/instanceConfig', () => ({ assertLegalSurfacesEnabled: vi.fn() }))
vi.mock('../../../server/utils/billing/entitlements', () => ({
  resolveDocPlanFor: vi.fn(async () => 'free'),
  resolveUserPlan: vi.fn(async () => 'free'),
  resolveWorkspacePlan: vi.fn(async () => 'free'),
  assertPlanFeature: vi.fn(() => {
    if (!m.planOk) throw createError({ statusCode: 409, data: { code: 'plan/feature-unavailable' } })
  })
}))
vi.mock('../../../server/utils/platform/idempotency', () => ({
  withIdempotency: vi.fn(async (_e: unknown, scope: string, userId: number, fn: () => Promise<unknown>) => {
    m.idempotencyCalls.push(`${scope}:${userId}`)
    return fn()
  })
}))
vi.mock('../../../server/utils/rendering/renderTokens', () => ({
  verifyRenderToken: vi.fn((t: string, docId: string) => t === 'good' ? { scope: 'render', docId, snapshotId: 1 } : null)
}))

const SECRET = 'unit-test-jwt-secret-0123456789abcdef'
const INTERNAL = 'unit-test-internal-secret-0123456789'

const { defineApiHandler, lenientBody } = await import('../../../server/utils/api/defineApiHandler')
const { allow } = await import('../../../server/utils/api/policy')
const { decideDocNeed } = await import('../../../server/utils/api/policyDoc')
const { scimError } = await import('../../../server/utils/sso/scimErrors')
type DocNeed = Parameters<typeof decideDocNeed>[0]

async function call(handler: EventHandler, route: string, url: string, init: RequestInit = {}) {
  const app = createApp()
  const router = createRouter()
  router.use(route, handler)
  app.use(router)
  const res = await toWebHandler(app)(new Request(`http://app.test${url}`, init))
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body: body as { data?: Record<string, unknown>, message?: string } & Record<string, unknown> }
}

beforeEach(() => {
  stubEnv({ NUXT_JWT_SECRET: SECRET, NUXT_INTERNAL_API_SECRET: INTERNAL })
  Object.assign(m, {
    user: null, recent: true, isAdmin: false, row: null, memberRole: null, memberRoleIgnoringSso: null, membership: null,
    ssoError: null, rateAllowed: true, billingOn: true, planOk: true, idempotencyCalls: [], scimDeny: null, rateCalls: [], customDomains: true, traefik: null
  })
  delete process.env.TEST_MODE
})

// ---------------------------------------------------------------------------
// Document matrix
// ---------------------------------------------------------------------------

const CREATOR_KEY = 'k'.repeat(43)
type DocKind = 'standalone' | 'workspace' | 'anonymous'
interface Actor {
  label: string
  userId: number | null
  role: WorkspaceRole | null
  isGuest?: boolean
  suspended?: boolean
  token?: 'session-jwt' | 'file-jwt' | 'foreign-jwt'
  creatorKey?: boolean
}
const ACTORS: Actor[] = [
  { label: 'anonymous', userId: null, role: null },
  { label: 'anonymous + password JWT', userId: null, role: null, token: 'session-jwt' },
  { label: 'anonymous + file-access JWT', userId: null, role: null, token: 'file-jwt' },
  { label: 'anonymous + JWT of another doc', userId: null, role: null, token: 'foreign-jwt' },
  { label: 'anonymous creator browser', userId: null, role: null, creatorKey: true },
  { label: 'signed-in non-member', userId: 2, role: null },
  { label: 'owner', userId: 1, role: null },
  { label: 'owner suspended by SSO', userId: 1, role: null, suspended: true },
  { label: 'owner + workspace editor', userId: 1, role: 'editor' },
  { label: 'workspace viewer', userId: 3, role: 'viewer' },
  { label: 'workspace editor', userId: 3, role: 'editor' },
  { label: 'workspace admin', userId: 3, role: 'admin' },
  { label: 'guest with view share', userId: 4, role: 'viewer', isGuest: true },
  { label: 'guest with edit share', userId: 4, role: 'editor', isGuest: true }
]
const MODES: AccessMode[] = ['private', 'open-edit', 'open-view', 'password-protected']
const NEEDS: DocNeed[] = ['file', 'activity', 'write-content', 'edit', 'manage', 'share-guests', 'delete', 'lookup']

function rowFor(kind: DocKind, mode: AccessMode, expired: boolean, actor: Actor): DocAuthzRow {
  const inWorkspace = kind === 'workspace'
  return {
    ownerId: kind === 'anonymous' ? null : 1,
    workspaceId: inWorkspace ? 'w1' : null,
    accessMode: kind === 'anonymous' ? 'open-edit' : mode,
    anonCreatorKeyHash: kind === 'anonymous' ? hashAnonCreatorKey(CREATOR_KEY) : null,
    theme: null,
    // getDocWithActorRole only returns a role for members of the doc's workspace.
    workspaceRole: inWorkspace ? actor.role : null,
    isGuest: inWorkspace && actor.isGuest === true,
    ownerAccessSuspended: inWorkspace && actor.suspended === true,
    shareExpiresAt: expired ? new Date(Date.now() - 60_000) : null,
    shareNoDownload: false,
    title: 'T',
    description: '',
    audience: 'business',
    language: 'en',
    templateId: 'blank'
  } as DocAuthzRow
}

function headersFor(actor: Actor, docId: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (actor.token === 'session-jwt') h.authorization = `Bearer ${jwt.sign({ docId, userId: 'anon', readOnly: true }, SECRET)}`
  if (actor.token === 'file-jwt') h.authorization = `Bearer ${jwt.sign({ docId, scope: 'file-access' }, SECRET)}`
  if (actor.token === 'foreign-jwt') h.authorization = `Bearer ${jwt.sign({ docId: 'other', userId: 'anon' }, SECRET)}`
  if (actor.creatorKey) h.cookie = `markoto-anon-creator=${CREATOR_KEY}`
  return h
}

/** What the existing decision functions say, independent of the wrapper. */
function expected(need: DocNeed, row: DocAuthzRow, actor: Actor, opts: { anonymous: boolean, jwt: boolean }): number {
  const userId = actor.userId
  if (userId === null && !opts.anonymous) return 401
  const state = docStateOf(row)
  const jwtValid = opts.jwt && (actor.token === 'session-jwt' || actor.token === 'file-jwt')
  const base: ActorState = { userId, workspaceRole: row.workspaceRole, isGuest: row.isGuest }
  const owner = isEffectiveDocOwner(row, userId)
  switch (need) {
    case 'lookup': return 200
    case 'file': return decideFileAccess(state, { ...base, hasValidDocJwt: jwtValid }).outcome === 'allow' ? 200 : 403
    case 'activity': return decideActivityAccess(state, { ...base, hasValidDocJwt: jwtValid }).outcome === 'allow' ? 200 : 403
    case 'delete': {
      const d = decideDocDelete(state, { ...base, isAnonCreator: actor.creatorKey === true })
      return d.outcome === 'allow' ? 200 : d.reason === 'authentication-required' ? 401 : 403
    }
    case 'write-content': {
      if (userId === null) return 401
      const d = decideTokenAccess(state, { userId, workspaceRole: row.workspaceRole })
      return d.outcome === 'allow' && !d.readOnly ? 200 : 403
    }
    case 'edit': return owner || row.workspaceRole === 'admin' || row.workspaceRole === 'editor' ? 200 : 403
    case 'manage': return owner || row.workspaceRole === 'admin' ? 200 : 403
    // requireDocSharingAccess: admin / editor MEMBER (getMemberRole excludes guests) of the doc's workspace.
    case 'share-guests': return row.workspaceId !== null && !row.isGuest && (row.workspaceRole === 'admin' || row.workspaceRole === 'editor') ? 200 : 403
  }
}

describe('allow.doc — need × access mode × role × anonymous / JWT, against docPermissions', () => {
  for (const need of NEEDS) {
    it(`need '${need}'`, async () => {
      const mismatches: string[] = []
      let cases = 0
      for (const anonymous of [false, true]) {
        for (const withJwt of [false, true]) {
          const handler = defineApiHandler({
            access: allow.doc(need, { anonymous, ...(withJwt ? { jwt: ['file-access'] as const } : {}), reason: 'matrix', deny: 'files/access-denied' }),
            handler: ({ docId, state, authz }) => ({ docId, mode: state.accessMode, canManage: authz.canManage })
          })
          for (const kind of ['standalone', 'workspace', 'anonymous'] as DocKind[]) {
            for (const mode of kind === 'anonymous' ? ['open-edit' as AccessMode] : MODES) {
              for (const expired of [false, true]) {
                for (const actor of ACTORS) {
                  if (kind !== 'workspace' && (actor.role !== null || actor.suspended)) continue
                  const row = rowFor(kind, mode, expired, actor)
                  m.row = row
                  m.user = actor.userId === null ? null : { id: actor.userId, name: 'U' }
                  const res = await call(handler as EventHandler, '/api/docs/:docId/x', '/api/docs/d1/x', { headers: headersFor(actor, 'd1') })
                  const want = expected(need, row, actor, { anonymous, jwt: withJwt })
                  cases++
                  if (res.status !== want) mismatches.push(`${kind}/${mode}${expired ? '/expired' : ''} ${actor.label} anon=${anonymous} jwt=${withJwt}: got ${res.status}, want ${want}`)
                  else if (want === 403 && res.body.data?.code !== 'files/access-denied') mismatches.push(`${kind}/${mode} ${actor.label}: deny code ${String(res.body.data?.code)}`)
                }
              }
            }
          }
        }
      }
      expect(mismatches).toEqual([])
      // 2 anonymous × 2 jwt × (56 standalone + 112 workspace + 14 anonymous-doc) cells.
      expect(cases).toBe(728)
    })
  }

  it('a missing document is 404 docs/not-found, for every need', async () => {
    m.user = { id: 1, name: 'U' }
    m.row = null
    for (const need of NEEDS) {
      const res = await call(defineApiHandler({ access: allow.doc(need, { reason: 'x' }), handler: () => 'ok' }) as EventHandler, '/api/docs/:docId', '/api/docs/nope')
      expect(res.status).toBe(404)
      expect(res.body.data?.code).toBe('docs/not-found')
    }
  })

  it('reads the doc id from the body when told to, and 400s without one', async () => {
    m.user = { id: 1, name: 'U' }
    m.row = rowFor('standalone', 'private', false, ACTORS[6]!)
    const handler = defineApiHandler({
      access: allow.doc('write-content', { docId: { from: 'body' } }),
      body: z.object({ docId: z.string().optional() }),
      handler: ({ docId }) => ({ docId })
    }) as EventHandler
    const post = (body: unknown) => call(handler, '/api/x', '/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    expect((await post({ docId: 'abc' })).body).toEqual({ docId: 'abc' })
    const missing = await post({})
    expect(missing.status).toBe(400)
    expect(missing.body.data).toMatchObject({ code: 'request/invalid', field: 'docId' })
  })

  it('pure decideDocNeed denies an unknown need', () => {
    const row = rowFor('standalone', 'open-edit', false, ACTORS[6]!)
    expect(decideDocNeed('nope' as DocNeed, row, docStateOf(row), { userId: 1, workspaceRole: null })).toEqual({ allow: false, status: 403 })
  })

  it('refuses to build a lookup policy without a reason, or an unknown need', () => {
    expect(() => allow.doc('lookup')).toThrow(/reason/)
    expect(() => allow.doc('nope' as DocNeed)).toThrow(/unknown need/)
  })
})

// ---------------------------------------------------------------------------
// Workspace policy
// ---------------------------------------------------------------------------

describe('allow.workspace', () => {
  const route = '/api/workspaces/:wsId/x'
  const url = '/api/workspaces/w1/x'
  it.each([
    ['member', null, 404], ['member', 'viewer', 200], ['member', 'editor', 200], ['member', 'admin', 200],
    ['editor', null, 404], ['editor', 'viewer', 403], ['editor', 'editor', 200], ['editor', 'admin', 200],
    ['admin', null, 404], ['admin', 'viewer', 403], ['admin', 'editor', 403], ['admin', 'admin', 200]
  ] as const)('need %s, role %s → %i', async (need, role, status) => {
    m.user = { id: 7, name: 'U' }
    m.memberRole = role
    const res = await call(defineApiHandler({ access: allow.workspace(need, { deny: 'brand/admin-required' }), handler: ({ wsId, role: r }) => ({ wsId, role: r }) }) as EventHandler, route, url)
    expect(res.status).toBe(status)
    if (status === 200) expect(res.body).toEqual({ wsId: 'w1', role })
    if (status === 404) expect(res.body.data?.code).toBe('workspace/not-found')
    if (status === 403) expect(res.body.data?.code).toBe('brand/admin-required')
  })

  it('401 without a session; guests and SSO-less members (null role) are 404', async () => {
    const handler = defineApiHandler({ access: allow.workspace('member'), handler: () => 'ok' }) as EventHandler
    expect((await call(handler, route, url)).status).toBe(401)
    m.user = { id: 7, name: 'U' }
    expect((await call(handler, route, url)).status).toBe(404)
  })

  it('ssoHint answers sso/required for a member without a current SSO sign-in', async () => {
    m.user = { id: 7, name: 'U' }
    m.ssoError = createError({ statusCode: 403, data: { code: 'sso/required', loginUrl: '/x' } })
    const res = await call(defineApiHandler({ access: allow.workspace('member', { ssoHint: true }), handler: () => 'ok' }) as EventHandler, route, url)
    expect(res.status).toBe(403)
    expect(res.body.data?.code).toBe('sso/required')
    const plain = await call(defineApiHandler({ access: allow.workspace('member'), handler: () => 'ok' }) as EventHandler, route, url)
    expect(plain.status).toBe(404)
  })

  it('ignoreSso reads the role without the SSO condition (break-glass for the SSO settings)', async () => {
    m.user = { id: 7, name: 'U' }
    m.memberRole = null
    m.memberRoleIgnoringSso = 'admin'
    expect((await call(defineApiHandler({ access: allow.workspace('admin', { ignoreSso: true }), handler: () => 'ok' }) as EventHandler, route, url)).status).toBe(200)
    expect((await call(defineApiHandler({ access: allow.workspace('admin'), handler: () => 'ok' }) as EventHandler, route, url)).status).toBe(404)
  })

  describe('orSelf (remove a member / leave)', () => {
    const selfRoute = '/api/workspaces/:wsId/members/:userId'
    const params = z.object({ wsId: z.string(), userId: z.coerce.number().int().positive() })
    const handler = defineApiHandler({
      access: allow.workspace('admin', { orSelf: 'userId', deny: 'workspace/admin-required' }),
      params,
      handler: ({ role, targetUserId, isSelf }) => ({ role, targetUserId, isSelf })
    }) as EventHandler
    // caller 7; role = their workspace role (null: no role), membership = the raw row (guest)
    it.each([
      ['admin removes another', 'admin', null, 8, 200],
      ['admin leaves', 'admin', null, 7, 200],
      ['editor removes another', 'editor', null, 8, 403],
      ['viewer removes another', 'viewer', null, 8, 403],
      ['editor leaves', 'editor', null, 7, 200],
      ['viewer leaves', 'viewer', null, 7, 200],
      ['guest leaves', null, 'guest', 7, 200],
      ['guest removes another', null, 'guest', 8, 404],
      ['outsider removes someone', null, null, 8, 404],
      ['outsider "leaves"', null, null, 7, 404]
    ] as const)('%s → %i', async (_label, role, membership, target, status) => {
      m.user = { id: 7, name: 'U' }
      m.memberRole = role
      m.membership = membership
      const res = await call(handler, selfRoute, `/api/workspaces/w1/members/${target}`, { method: 'DELETE' })
      expect(res.status).toBe(status)
      if (status === 200) expect(res.body).toEqual({ role: role ?? 'guest', targetUserId: target, isSelf: target === 7 })
      if (status === 403) expect(res.body.data?.code).toBe('workspace/admin-required')
      if (status === 404) expect(res.body.data?.code).toBe('workspace/not-found')
    })

    it('401 without a session; a bad user id is 400 before any role lookup', async () => {
      expect((await call(handler, selfRoute, '/api/workspaces/w1/members/7', { method: 'DELETE' })).status).toBe(401)
      m.user = { id: 7, name: 'U' }
      const { getMemberRole } = await import('../../../server/repos/workspaceMembers')
      vi.mocked(getMemberRole).mockClear()
      expect((await call(handler, selfRoute, '/api/workspaces/w1/members/abc', { method: 'DELETE' })).status).toBe(400)
      expect(getMemberRole).not.toHaveBeenCalled()
    })

    it('fails closed without a parsed (numeric) target parameter', async () => {
      m.user = { id: 7, name: 'U' }
      m.memberRole = 'viewer'
      const unparsed = defineApiHandler({ access: allow.workspace('admin', { orSelf: 'userId' }), handler: () => 'ran' }) as EventHandler
      expect((await call(unparsed, selfRoute, '/api/workspaces/w1/members/7', { method: 'DELETE' })).status).toBe(400)
      expect(() => allow.workspace('admin', { orSelf: '' })).toThrow(/orSelf/)
    })
  })
})

// ---------------------------------------------------------------------------
// Other policies
// ---------------------------------------------------------------------------

describe('session, admin, public, internal, test-only, custom', () => {
  it('user: 401 anonymous, 200 signed in; recentLogin adds auth/reauth-required', async () => {
    const handler = defineApiHandler({ access: allow.user(), handler: ({ user }) => ({ id: user.id }) }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(401)
    m.user = { id: 5, name: 'U' }
    expect((await call(handler, '/api/x', '/api/x')).body).toEqual({ id: 5 })
    const recent = defineApiHandler({ access: allow.user(), recentLogin: true, handler: () => 'ok' }) as EventHandler
    m.recent = false
    const res = await call(recent, '/api/x', '/api/x')
    expect(res.status).toBe(401)
    expect(res.body.data?.code).toBe('auth/reauth-required')
  })

  it('admin: 401 anonymous, 403 non-admin (before the body is read), 200 admin', async () => {
    const handler = defineApiHandler({ access: allow.admin(), body: z.object({ n: z.number() }), handler: ({ admin }) => ({ admin: admin.userId }) }) as EventHandler
    const post = (body: unknown) => call(handler, '/api/x', '/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    expect((await post({ n: 'bad' })).status).toBe(401)
    m.user = { id: 5, name: 'U' }
    const refused = await post({ n: 'bad' })
    expect(refused.status).toBe(403)
    expect(refused.body.data?.code).toBe('admin/forbidden')
    m.isAdmin = true
    expect((await post({ n: 'bad' })).status).toBe(400)
    expect((await post({ n: 1 })).body).toEqual({ admin: 5 })
  })

  it('public never reads the session; session: optional does', async () => {
    m.user = { id: 5, name: 'U' }
    const pub = defineApiHandler({ access: allow.public('test'), handler: ({ user }) => ({ user }) }) as EventHandler
    expect((await call(pub, '/api/x', '/api/x')).body).toEqual({ user: null })
    const opt = defineApiHandler({ access: allow.public('test', { session: 'optional' }), handler: ({ user }) => ({ user: user?.id ?? null }) }) as EventHandler
    expect((await call(opt, '/api/x', '/api/x')).body).toEqual({ user: 5 })
    expect(() => allow.public('  ')).toThrow(/reason/)
  })

  it('internal secret: wrong secret 401, edge-proxied 404, right secret 200', async () => {
    const handler = defineApiHandler({ access: allow.internal('secret'), handler: () => 'ok' }) as EventHandler
    expect((await call(handler, '/api/internal/x', '/api/internal/x', { headers: { 'x-internal-secret': 'nope' } })).status).toBe(401)
    expect((await call(handler, '/api/internal/x', '/api/internal/x', { headers: { 'x-internal-secret': INTERNAL, 'x-forwarded-host': 'evil' } })).status).toBe(404)
    expect((await call(handler, '/api/internal/x', '/api/internal/x', { headers: { 'x-internal-secret': INTERNAL } })).status).toBe(200)
  })

  it('internal render token: 400 without docId / t, 403 with a bad token, claims on success', async () => {
    const handler = defineApiHandler({ access: allow.internal('render-token'), handler: ({ render }) => ({ docId: render?.docId }) }) as EventHandler
    expect((await call(handler, '/api/r', '/api/r?docId=d1')).status).toBe(400)
    expect((await call(handler, '/api/r', '/api/r?docId=d1&t=bad')).status).toBe(403)
    expect((await call(handler, '/api/r', '/api/r?docId=d1&t=good')).body).toEqual({ docId: 'd1' })
  })

  it('test-only routes 404 outside test mode, before the session', async () => {
    const handler = defineApiHandler({ access: allow.testOnly({ session: 'required' }), handler: ({ user }) => ({ user: user?.id }) }) as EventHandler
    expect((await call(handler, '/api/_test/x', '/api/_test/x')).status).toBe(404)
    process.env.TEST_MODE = '1'
    expect((await call(handler, '/api/_test/x', '/api/_test/x')).status).toBe(401)
    m.user = { id: 5, name: 'U' }
    expect((await call(handler, '/api/_test/x', '/api/_test/x')).body).toEqual({ user: 5 })
  })

  it('custom: a non-sessionless check still requires a session first', async () => {
    const check = vi.fn(async () => ({ user: null, extra: 1 }))
    const handler = defineApiHandler({ access: allow.custom('test', { sessionless: false, check }), handler: ({ extra }) => ({ extra }) }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(401)
    expect(check).not.toHaveBeenCalled()
    m.user = { id: 5, name: 'U' }
    expect((await call(handler, '/api/x', '/api/x')).body).toEqual({ extra: 1 })
  })
})

// ---------------------------------------------------------------------------
// Fail closed + wrapper steps
// ---------------------------------------------------------------------------

describe('fail closed', () => {
  it('a route whose access is not an allow.* policy answers 500 and never runs', async () => {
    const run = vi.fn(() => 'ran')
    const bogus = { kind: 'user', sessionless: false, gate: async () => ({ user: null }) }
    const handler = defineApiHandler({ access: bogus as never, handler: run }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(500)
    const unknownKind = { ...bogus, kind: 'everyone', resolve: async () => ({}) }
    expect((await call(defineApiHandler({ access: unknownKind as never, handler: run }) as EventHandler, '/api/x', '/api/x')).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })

  it('a resolve that throws a non-HTTP error denies with 500', async () => {
    const run = vi.fn(() => 'ran')
    const handler = defineApiHandler({
      access: allow.custom('test', { sessionless: true, check: async () => { throw new Error('db down') } }),
      handler: run
    }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })

  it('a resolve that returns no context denies with 500', async () => {
    const run = vi.fn(() => 'ran')
    const handler = defineApiHandler({ access: allow.custom('test', { sessionless: true, check: async () => null as never }), handler: run }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })

  it('a per-user rate limit on a route without a user is refused, not keyed on nothing', async () => {
    const run = vi.fn(() => 'ran')
    const handler = defineApiHandler({ access: allow.public('test'), rateLimit: { namespace: 'n', max: 1, windowMs: 1, key: 'user' }, handler: run }) as EventHandler
    expect((await call(handler, '/api/x', '/api/x')).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('inputs, gates and order', () => {
  it('validation failures carry the code, the first field and every issue', async () => {
    m.user = { id: 1, name: 'U' }
    const handler = defineApiHandler({
      access: allow.user(),
      body: z.object({ a: z.string().min(3), b: z.boolean() }),
      invalidCode: 'share/invalid',
      handler: ({ body }) => body
    }) as EventHandler
    const res = await call(handler, '/api/x', '/api/x', { method: 'PUT', body: JSON.stringify({ a: 'x', b: 'no' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect(res.body.data).toMatchObject({ code: 'share/invalid', field: 'a' })
    expect(res.body.data?.fields).toEqual([
      expect.objectContaining({ path: 'a', issue: 'too_small', minimum: 3 }),
      expect.objectContaining({ path: 'b', issue: 'invalid_type', expected: 'boolean' })
    ])
    const badJson = await call(handler, '/api/x', '/api/x', { method: 'PUT', body: '{', headers: { 'content-type': 'application/json' } })
    expect(badJson.status).toBe(400)
    expect(badJson.body.data?.code).toBe('share/invalid')
  })

  it('apiError renders the English catalog text with its params, and checks params in test mode', async () => {
    const { apiError } = await import('../../../server/utils/api/apiError')
    const e = apiError('share/expiry-too-far', { field: 'expiresAt', maxDays: 366 })
    expect(e.statusCode).toBe(400)
    expect(e.message).toBe('The expiry can be at most 366 days away.')
    expect(e.data).toEqual({ code: 'share/expiry-too-far', field: 'expiresAt', maxDays: 366 })
    expect(apiError('publish/not-published', undefined, { status: 409 }).statusCode).toBe(409)
    process.env.TEST_MODE = '1'
    expect(() => (apiError as (c: string, p?: unknown) => Error)('share/expiry-too-far', { maxDays: 'x' })).toThrow(/params/)
    expect(() => (apiError as (c: string, p?: unknown, o?: unknown) => Error)('share/not-allowed', undefined, { status: 404 })).toThrow(/status 404/)
  })

  it('params and query are parsed (coerced) and typed', async () => {
    const handler = defineApiHandler({
      access: allow.public('test'),
      params: z.object({ id: z.string().regex(/^\d+$/) }),
      query: z.object({ n: z.coerce.number().int().optional() }),
      handler: ({ params, query }) => ({ id: params.id, n: query.n })
    }) as EventHandler
    expect((await call(handler, '/api/x/:id', '/api/x/12?n=3')).body).toEqual({ id: '12', n: 3 })
    expect((await call(handler, '/api/x/:id', '/api/x/ab')).status).toBe(400)
    expect((await call(handler, '/api/x/:id', '/api/x/12?n=1.5')).body.data).toMatchObject({ code: 'request/invalid', field: 'n' })
  })

  it('order: instance → session → input (400) → access (403) → plan → rate limit → handler', async () => {
    const run = vi.fn(() => 'ran')
    const handler = defineApiHandler({
      access: allow.doc('manage'),
      instance: 'billing',
      body: z.object({ n: z.number() }),
      plan: { feature: 'shareControls', message: 'Paid feature.' },
      rateLimit: { namespace: 'n', max: 1, windowMs: 1, key: 'user', error: 'share/rate-limited' },
      handler: run
    }) as EventHandler
    const put = (body: unknown) => call(handler, '/api/docs/:docId', '/api/docs/d1', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    m.billingOn = false
    expect((await put({})).body.data?.code).toBe('billing/disabled')
    m.billingOn = true
    expect((await put({})).status).toBe(401)
    m.user = { id: 2, name: 'U' }
    m.row = rowFor('standalone', 'open-edit', false, ACTORS[5]!)
    expect((await put({})).status).toBe(400)
    expect((await put({ n: 1 })).status).toBe(403)
    m.user = { id: 1, name: 'U' }
    m.row = rowFor('standalone', 'open-edit', false, ACTORS[6]!)
    m.planOk = false
    expect((await put({ n: 1 })).body.data?.code).toBe('plan/feature-unavailable')
    m.planOk = true
    m.rateAllowed = false
    const limited = await put({ n: 1 })
    expect(limited.status).toBe(429)
    expect(limited.body.data?.code).toBe('share/rate-limited')
    expect(run).not.toHaveBeenCalled()
    m.rateAllowed = true
    expect((await put({ n: 1 })).body).toBe('ran')
  })

  it('idempotency wraps the handler with the user id; raw bodies are handed over unparsed', async () => {
    m.user = { id: 9, name: 'U' }
    const handler = defineApiHandler({ access: allow.user(), body: 'raw', idempotency: { scope: 'dup' }, handler: async ({ rawBody }) => ({ len: (await rawBody())?.length }) }) as EventHandler
    const res = await call(handler, '/api/x', '/api/x', { method: 'POST', body: 'abcdef' })
    expect(res.body).toEqual({ len: 6 })
    expect(m.idempotencyCalls).toEqual(['dup:9'])
  })

  it('exposes the declared policy as ~access', () => {
    const h = defineApiHandler({ access: allow.doc('file', { anonymous: true }), handler: () => null })
    expect(h['~access']).toEqual({ kind: 'doc', sessionless: true, need: 'file', reason: undefined })
    expect(defineApiHandler({ access: allow.admin(), handler: () => null })['~access']).toMatchObject({ kind: 'admin', sessionless: false })
  })
})

// ---------------------------------------------------------------------------
// Error formats (allow.scim): every refusal in the protocol's own body
// ---------------------------------------------------------------------------

describe('error formats', () => {
  const JSON_TYPE = { 'content-type': 'application/json' }
  const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
  const scimRoute = (handler: (ctx: { params: { id: number }, body: Record<string, unknown> }) => unknown) => defineApiHandler({
    access: allow.scim(),
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.record(z.string(), z.unknown()),
    handler: ctx => handler(ctx)
  }) as EventHandler

  it('a gate refusal leaves as the SCIM body with its status and content type', async () => {
    m.scimDeny = scimError(401, 'A valid SCIM bearer token is required.')
    const run = vi.fn()
    const res = await call(scimRoute(run), '/scim/Users/:id', '/scim/Users/1', { method: 'PATCH', body: '{}', headers: JSON_TYPE })
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/scim+json; charset=utf-8')
    expect(res.body).toEqual({ schemas: [SCIM_ERROR], status: '401', detail: 'A valid SCIM bearer token is required.' })
    expect(run).not.toHaveBeenCalled()
  })

  it('schema failures use the format\'s refusals: params 404, body 400 invalidSyntax (also for broken JSON)', async () => {
    const run = vi.fn()
    const badId = await call(scimRoute(run), '/scim/Users/:id', '/scim/Users/abc', { method: 'PATCH', body: '{}', headers: JSON_TYPE })
    expect(badId).toMatchObject({ status: 404, body: { schemas: [SCIM_ERROR], status: '404', detail: 'User not found.' } })
    for (const body of ['[1]', '"x"', '{"a":']) {
      const res = await call(scimRoute(run), '/scim/Users/:id', '/scim/Users/1', { method: 'PATCH', body, headers: { 'content-type': 'application/json' } })
      expect(res, body).toMatchObject({ status: 400, body: { status: '400', scimType: 'invalidSyntax', detail: 'The request body must be a JSON object.' } })
      expect(res.body.data).toBeUndefined()
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('a SCIM error thrown by the handler keeps its status and scimType; success passes through', async () => {
    const conflict = await call(scimRoute(() => {
      throw scimError(409, 'dup', 'uniqueness')
    }), '/scim/Users/:id', '/scim/Users/1', { method: 'PATCH', body: '{}', headers: JSON_TYPE })
    expect(conflict).toMatchObject({ status: 409, body: { schemas: [SCIM_ERROR], status: '409', detail: 'dup', scimType: 'uniqueness' } })
    const ok = await call(scimRoute(({ params, body }) => ({ id: params.id, body })), '/scim/Users/:id', '/scim/Users/7', { method: 'PATCH', body: '{"a":1}', headers: JSON_TYPE })
    expect(ok).toMatchObject({ status: 200, body: { id: 7, body: { a: 1 } } })
  })

  it('any other error (API envelope, plain Error) is a generic SCIM 500 without details', async () => {
    for (const thrown of [new Error('db down: secret'), createError({ statusCode: 403, data: { code: 'auth/forbidden' } })]) {
      const res = await call(scimRoute(() => {
        throw thrown
      }), '/scim/Users/:id', '/scim/Users/1', { method: 'PATCH', body: '{}', headers: JSON_TYPE })
      expect(res).toMatchObject({ status: 500, body: { schemas: [SCIM_ERROR], status: '500', detail: 'Something went wrong on our side.' } })
      expect(JSON.stringify(res.body)).not.toContain('secret')
    }
  })

  it('fails closed: a formatter cannot turn a refusal into a success, and a throwing formatter rethrows the error', async () => {
    const base = allow.scim()
    const run = vi.fn()
    const lying = { ...base, errorFormat: { invalid: base.errorFormat!.invalid, respond: () => ({ status: 200, body: { ok: true }, contentType: 'application/json' }) } }
    m.scimDeny = scimError(401, 'no')
    const res = await call(defineApiHandler({ access: lying as never, handler: run }) as EventHandler, '/x', '/x')
    expect(res.status).toBe(500)
    const throwing = { ...base, errorFormat: { invalid: base.errorFormat!.invalid, respond: () => {
      throw new Error('formatter bug')
    } } }
    const res2 = await call(defineApiHandler({ access: throwing as never, handler: run }) as EventHandler, '/x', '/x')
    expect(res2.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('routes without an error format keep the API envelope', async () => {
    const res = await call(defineApiHandler({ access: allow.public('t'), params: z.object({ id: z.coerce.number() }), handler: () => null }) as EventHandler, '/x/:id', '/x/abc')
    expect(res).toMatchObject({ status: 400, body: { data: { code: 'request/invalid', field: 'id' } } })
  })
})

describe('rate limits: keys and phases', () => {
  it('user+ip keys on `<userId>:<client key>`; a key function also gets the event', async () => {
    m.user = { id: 4, name: 'U' }
    const handler = defineApiHandler({
      access: allow.user(),
      rateLimit: [
        { namespace: 'both', max: 1, windowMs: 1, key: 'user+ip' },
        { namespace: 'fn', max: 1, windowMs: 1, key: (ctx, event) => `${ctx.user.id}/${event.method}` }
      ],
      handler: () => 'ok'
    }) as EventHandler
    expect((await call(handler, '/x', '/x')).status).toBe(200)
    expect(m.rateCalls).toEqual(['both=4:203.0.113.7', 'fn=4/GET'])
  })

  it('user+ip on a route without a user is refused (500), never keyed on the address alone', async () => {
    const run = vi.fn()
    const handler = defineApiHandler({ access: allow.public('t'), rateLimit: { namespace: 'n', max: 1, windowMs: 1, key: 'user+ip' }, handler: run }) as EventHandler
    expect((await call(handler, '/x', '/x')).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })

  it('before-access limits count requests for unknown documents and run before the session and the lookup', async () => {
    m.rateAllowed = true
    const handler = defineApiHandler({
      access: allow.doc('file', { anonymous: true }),
      rateLimit: { namespace: 'early', max: 1, windowMs: 1, key: 'ip', phase: 'before-access' },
      handler: () => 'ok'
    }) as EventHandler
    m.row = null
    expect((await call(handler, '/api/docs/:docId', '/api/docs/nope')).status).toBe(404)
    expect(m.rateCalls).toEqual(['early=203.0.113.7'])
    // Over the limit: 429 before the session or the document is read.
    m.rateAllowed = false
    m.user = { id: 1, name: 'U' }
    const { getDocWithActorRole } = await import('../../../server/repos/documents')
    const { getValidatedUserSession } = await import('../../../server/utils/auth/validatedSession')
    vi.mocked(getDocWithActorRole).mockClear()
    vi.mocked(getValidatedUserSession).mockClear()
    const res = await call(handler, '/api/docs/:docId', '/api/docs/nope')
    expect(res.status).toBe(429)
    expect(res.body.data?.code).toBe('rate/limited')
    expect(getDocWithActorRole).not.toHaveBeenCalled()
    expect(getValidatedUserSession).not.toHaveBeenCalled()
  })

  it('after-access limits (the default) do not count requests that access refuses', async () => {
    m.row = null
    const handler = defineApiHandler({ access: allow.doc('file', { anonymous: true }), rateLimit: { namespace: 'late', max: 1, windowMs: 1, key: 'ip' }, handler: () => 'ok' }) as EventHandler
    expect((await call(handler, '/api/docs/:docId', '/api/docs/nope')).status).toBe(404)
    expect(m.rateCalls).toEqual([])
  })

  it('a before-access limit keyed on anything but the client address does not build', () => {
    expect(() => defineApiHandler({ access: allow.user(), rateLimit: { namespace: 'x', max: 1, windowMs: 1, key: 'user', phase: 'before-access' } as never, handler: () => null })).toThrow(/before-access/)
    expect(() => defineApiHandler({ access: allow.user(), rateLimit: { namespace: 'x', max: 1, windowMs: 1, key: () => 'k', phase: 'before-access' } as never, handler: () => null })).toThrow(/before-access/)
  })
})

describe('instance: customDomains', () => {
  it('404 custom-domain/disabled before the session, the plan and the rate limit when the instance runs none', async () => {
    m.customDomains = false
    m.planOk = false
    const run = vi.fn()
    const handler = defineApiHandler({
      access: allow.user(),
      instance: 'customDomains',
      plan: { feature: 'customDomains', message: 'x' },
      rateLimit: { namespace: 'cd', max: 1, windowMs: 1, key: 'user' },
      handler: run
    }) as EventHandler
    const res = await call(handler, '/x', '/x')
    expect(res).toMatchObject({ status: 404, body: { data: { code: 'custom-domain/disabled' } } })
    expect(m.rateCalls).toEqual([])
    m.customDomains = true
    expect((await call(handler, '/x', '/x')).status).toBe(401)
    m.user = { id: 1, name: 'U' }
    expect((await call(handler, '/x', '/x')).status).toBe(409)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('allow.internal(\'traefik-token\')', () => {
  it('a wrong provider token is 403 with cache-control: no-store; no settings = empty answer', async () => {
    const handler = defineApiHandler({ access: allow.internal('traefik-token'), handler: ({ traefik }) => traefik ? { cfg: 1 } : {} }) as EventHandler
    m.traefik = { token: 'right-token-right-token-right-token' }
    const denied = await call(handler, '/api/internal/t', '/api/internal/t', { headers: { 'x-markoto-provider-token': 'wrong' } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    const ok = await call(handler, '/api/internal/t', '/api/internal/t', { headers: { 'x-markoto-provider-token': 'right-token-right-token-right-token' } })
    expect(ok).toMatchObject({ status: 200, body: { cfg: 1 } })
    expect(ok.headers.get('cache-control')).toBe('no-store')
    m.traefik = null
    expect((await call(handler, '/api/internal/t', '/api/internal/t')).body).toEqual({})
  })
})

describe('lenientBody', () => {
  const schema = z.object({ email: z.string() })
  const route = (seen: unknown[], before?: () => void) => defineApiHandler({
    access: allow.public('t'),
    body: lenientBody(schema),
    handler: async ({ parseBody, body }) => {
      before?.()
      seen.push(body, await parseBody())
      return 'ok'
    }
  }) as EventHandler

  it('is never a 400: unreadable JSON and schema failures are null; a valid body is parsed', async () => {
    for (const [raw, expected] of [['{"email":', null], ['[1]', null], ['{"email":5}', null], ['{"email":"a@b.test"}', { email: 'a@b.test' }]] as const) {
      const seen: unknown[] = []
      const res = await call(route(seen), '/x', '/x', { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } })
      expect(res.status, raw).toBe(200)
      expect(seen, raw).toEqual([undefined, expected])
    }
  })

  it('reads the body only when the handler asks (after its own first steps)', async () => {
    const order: string[] = []
    const handler = defineApiHandler({
      access: allow.public('t'),
      body: lenientBody(schema),
      handler: async ({ parseBody }) => {
        order.push('first step')
        order.push(`body ${JSON.stringify(await parseBody())}`)
        return 'ok'
      }
    }) as EventHandler
    await call(handler, '/x', '/x', { method: 'POST', body: '{"email":"x"}', headers: { 'content-type': 'application/json' } })
    expect(order).toEqual(['first step', 'body {"email":"x"}'])
  })
})
