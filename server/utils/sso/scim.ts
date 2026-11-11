// SCIM 2.0 user provisioning (RFC 7643/7644), `/scim/v2/Users` only; roles
// stay in markoto.
//
// The IdP holds a bearer token per connection (SHA-256 at rest, shown
// once). What the operations do:
//
//   create      the email (userName / primary email) must be in a verified
//               domain; uses the account with that address or creates one;
//               joins the workspace with the connection's default role
//               (seats + member limit like an invitation); stores a
//               placeholder identity `scim:<externalId|userName>` that the
//               user's first sign-in replaces with the IdP's real subject.
//   active=false  membership, SSO grant and workspace AI key removed, the
//               identity kept inactive (sign-in refused); reactivating
//               re-joins (seat check again).
//   delete      membership, grant, key and identity removed. The markoto
//               account stays: the person may use it elsewhere, and only
//               they can delete it.
//   name / email changes are not applied to the account (it belongs to the
//               person, not the workspace); `externalId` is stored.
//
// The last admin of a workspace can't be deactivated or deleted (409, same
// rule as in the app).

import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { and, eq, ilike, sql } from 'drizzle-orm'
import { userIdentities, users } from '../../db/schema'
import { useDatabase } from '../platform/database'
import {
  deleteSsoGrant,
  findIdentityById,
  getSsoConnectionByScimTokenHash,
  insertIdentity,
  isDomainVerifiedForWorkspace,
  setIdentityActive,
  setIdentityScimExternalId,
  type SsoConnectionRow,
  type UserIdentityRow
} from '../../repos/sso'
import { getMemberRoleIgnoringSso, removeMember } from '../../repos/workspaceMembers'
import { LastAdminError } from '../../repos/errors'
import { deleteMemberKey } from '../litellm/workspaceTeams'
import { listDocIdsInWorkspace } from '../../repos/documents'
import { notifySyncKickUser } from '../documents/syncNotify'
import { planHasFeature, resolveWorkspacePlan } from '../billing/entitlements'
import { emailDomain } from './domains'
import { joinWorkspaceBySso, SsoJoinRefused } from './membership'
import { ssoBaseUrl } from './http'
import { SCIM_PLACEHOLDER_PREFIX } from './scimPrefix'

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

const MAX_PAGE = 200

export function hashScimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newScimToken(): string {
  return `mkscim_${randomBytes(32).toString('base64url')}`
}

/** A SCIM error response (RFC 7644 §3.12). */
export function scimError(status: number, detail: string, scimType?: string): Error {
  return createError({ statusCode: status, message: detail, data: { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) } })
}

/**
 * Bearer token → connection. 401 without a valid token, 403 when the
 * workspace's plan no longer includes SSO. Rate limit: 600 / min / token.
 */
export async function requireScimConnection(event: H3Event): Promise<SsoConnectionRow> {
  const auth = getHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(\S{20,200})$/i.exec(auth)
  const connection = match ? await getSsoConnectionByScimTokenHash(hashScimToken(match[1]!)) : null
  if (!connection) {
    setHeader(event, 'www-authenticate', 'Bearer')
    throw scimError(401, 'A valid SCIM bearer token is required.')
  }
  if (!(await checkRateLimit('scim', connection.id, 600, 60_000))) throw scimError(429, 'Too many requests.')
  if (!planHasFeature(await resolveWorkspacePlan(connection.workspaceId), 'sso')) {
    throw scimError(403, 'Single sign-on and provisioning are not included in this workspace\'s plan.')
  }
  setHeader(event, 'content-type', 'application/scim+json; charset=utf-8')
  return connection
}

interface ScimUserRow {
  id: number
  userId: number
  externalId: string | null
  active: boolean
  email: string | null
  name: string
  subject: string
}

export function scimUserResource(event: H3Event, row: ScimUserRow) {
  const location = `${ssoBaseUrl(event)}/scim/v2/Users/${row.id}`
  const userName = row.email ?? (row.subject.startsWith(SCIM_PLACEHOLDER_PREFIX) ? row.subject.slice(SCIM_PLACEHOLDER_PREFIX.length) : row.subject)
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: String(row.id),
    ...(row.externalId ? { externalId: row.externalId } : {}),
    userName,
    displayName: row.name,
    name: { formatted: row.name },
    ...(row.email ? { emails: [{ value: row.email, primary: true, type: 'work' }] } : {}),
    active: row.active,
    meta: { resourceType: 'User', location }
  }
}

const userRowColumns = {
  id: userIdentities.id,
  userId: userIdentities.userId,
  externalId: userIdentities.scimExternalId,
  active: userIdentities.active,
  email: users.email,
  name: users.name,
  subject: userIdentities.subject
}

export async function getScimUser(connectionId: string, id: number): Promise<ScimUserRow | null> {
  return (await useDatabase().select(userRowColumns).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.connectionId, connectionId), eq(userIdentities.id, id))).limit(1))[0] ?? null
}

/** `userName eq "x"` / `externalId eq "x"` / `emails[...] eq` — what IdPs send to look a user up. */
export function parseScimFilter(filter: string | undefined): { attribute: 'userName' | 'externalId', value: string } | null | 'unsupported' {
  if (!filter) return null
  const m = /^\s*(userName|externalId|emails(?:\[type eq "work"\])?\.value|emails)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter)
  if (!m) return 'unsupported'
  const attr = m[1]!.toLowerCase().startsWith('externalid') ? 'externalId' : 'userName'
  return { attribute: attr, value: m[2]!.replace(/\\(.)/g, '$1') }
}

export async function listScimUsers(connectionId: string, opts: { filter: ReturnType<typeof parseScimFilter>, startIndex: number, count: number }): Promise<{ total: number, rows: ScimUserRow[] }> {
  const db = useDatabase()
  const conditions = [eq(userIdentities.connectionId, connectionId)]
  if (opts.filter && opts.filter !== 'unsupported') {
    conditions.push(opts.filter.attribute === 'externalId'
      ? eq(userIdentities.scimExternalId, opts.filter.value)
      : ilike(users.email, opts.filter.value.replace(/[%_\\]/g, m => `\\${m}`)))
  }
  const where = and(...conditions)
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId)).where(where))[0]?.n ?? 0)
  const rows = await db.select(userRowColumns).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId)).where(where)
    .orderBy(userIdentities.id)
    .offset(Math.max(0, opts.startIndex - 1)).limit(Math.min(MAX_PAGE, Math.max(0, opts.count)))
  return { total, rows }
}

/** The user's email from a SCIM User body: primary email, else userName when it is an address. */
function emailFromScimBody(body: Record<string, unknown>): string | null {
  const emails = Array.isArray(body.emails) ? body.emails as Array<Record<string, unknown>> : []
  const primary = emails.find(e => e?.primary === true) ?? emails[0]
  const candidates = [primary?.value, body.userName]
  for (const c of candidates) {
    if (typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim())) return c.trim().toLowerCase()
  }
  return null
}

function nameFromScimBody(body: Record<string, unknown>, email: string): string {
  const n = (body.name ?? {}) as Record<string, unknown>
  const parts = [n.givenName, n.familyName].filter(p => typeof p === 'string' && p.trim()) as string[]
  const display = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : null
  const formatted = typeof n.formatted === 'string' && n.formatted.trim() ? n.formatted.trim() : null
  return (display ?? formatted ?? (parts.length ? parts.join(' ') : email)).slice(0, 200)
}

/** SCIM booleans arrive as true / "True" / "false" (Entra ID sends strings). */
function scimBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
  return undefined
}

export async function createScimUser(connection: SsoConnectionRow, body: Record<string, unknown>): Promise<{ identity: UserIdentityRow, created: boolean }> {
  const email = emailFromScimBody(body)
  const domain = emailDomain(email)
  if (!email || !domain || !(await isDomainVerifiedForWorkspace(connection.workspaceId, domain))) {
    throw scimError(400, 'The user\'s email must be in a domain this workspace has verified.', 'invalidValue')
  }
  const externalId = typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim().slice(0, 255) : null
  const active = scimBoolean(body.active) ?? true

  const { userId, created } = await useDatabase().transaction(async (tx) => {
    const existing = (await tx.execute<{ id: number }>(sql`select id from ${users} where lower(email) = ${email} order by id limit 1 for update`)).rows[0]
    if (existing) return { userId: Number(existing.id), created: false }
    const inserted = await tx.insert(users).values({ name: nameFromScimBody(body, email), email }).returning({ id: users.id })
    return { userId: inserted[0]!.id, created: true }
  })

  const already = (await useDatabase().select({ id: userIdentities.id }).from(userIdentities)
    .where(and(eq(userIdentities.connectionId, connection.id), eq(userIdentities.userId, userId))).limit(1))[0]
  if (already) throw scimError(409, 'This user is already provisioned.', 'uniqueness')

  const identity = await insertIdentity({ userId, connectionId: connection.id, subject: `${SCIM_PLACEHOLDER_PREFIX}${externalId ?? email}`, scimExternalId: externalId })
  if (active) {
    try {
      await joinWorkspaceBySso({ workspaceId: connection.workspaceId, userId, email, defaultRole: connection.defaultRole })
    } catch (e) {
      // No membership → no provisioned identity either (the IdP retries).
      await useDatabase().delete(userIdentities).where(eq(userIdentities.id, identity.id))
      if (e instanceof SsoJoinRefused) throw scimError(409, e.message)
      throw e
    }
  } else {
    await setIdentityActive(identity.id, false)
  }
  return { identity: { ...identity, active }, created }
}

/** Membership out: key, grant, member row, live editor connections. */
async function removeFromWorkspace(connection: SsoConnectionRow, userId: number): Promise<void> {
  const role = await getMemberRoleIgnoringSso(connection.workspaceId, userId)
  if (role !== null) {
    await deleteMemberKey(connection.workspaceId, userId)
    try {
      await removeMember(connection.workspaceId, userId)
    } catch (e) {
      if (e instanceof LastAdminError) throw scimError(409, 'This user is the workspace\'s last admin. Make someone else admin first.', 'mutability')
      throw e
    }
    notifySyncKickUser(userId, await listDocIdsInWorkspace(connection.workspaceId))
  }
  await deleteSsoGrant(userId, connection.workspaceId)
}

async function setScimUserActive(connection: SsoConnectionRow, identity: UserIdentityRow, active: boolean): Promise<void> {
  if (active === identity.active) {
    if (!active) await removeFromWorkspace(connection, identity.userId)
    return
  }
  if (!active) {
    await removeFromWorkspace(connection, identity.userId)
    await setIdentityActive(identity.id, false)
    return
  }
  const email = (await useDatabase().select({ email: users.email }).from(users).where(eq(users.id, identity.userId)).limit(1))[0]?.email ?? null
  try {
    await joinWorkspaceBySso({ workspaceId: connection.workspaceId, userId: identity.userId, email, defaultRole: connection.defaultRole })
  } catch (e) {
    if (e instanceof SsoJoinRefused) throw scimError(409, e.message)
    throw e
  }
  await setIdentityActive(identity.id, true)
}

export async function deleteScimUser(connection: SsoConnectionRow, identity: UserIdentityRow): Promise<void> {
  await removeFromWorkspace(connection, identity.userId)
  await useDatabase().delete(userIdentities).where(eq(userIdentities.id, identity.id))
}

/**
 * Apply a PATCH (RFC 7644 §3.5.2): `active` and `externalId`, with or
 * without a `path` (Okta: `{op: replace, value: {active: false}}`;
 * Entra ID: `{op: Replace, path: active, value: "False"}`). Other
 * attributes are accepted and ignored (see the header).
 */
export async function patchScimUser(connection: SsoConnectionRow, identity: UserIdentityRow, body: Record<string, unknown>): Promise<void> {
  const ops = Array.isArray(body.Operations) ? body.Operations as Array<Record<string, unknown>> : null
  if (!ops) throw scimError(400, 'PATCH needs an Operations array.', 'invalidSyntax')
  let active: boolean | undefined
  let externalId: string | null | undefined
  for (const op of ops) {
    const kind = typeof op.op === 'string' ? op.op.toLowerCase() : ''
    if (kind !== 'replace' && kind !== 'add' && kind !== 'remove') throw scimError(400, `Unsupported operation "${String(op.op)}".`, 'invalidSyntax')
    const path = typeof op.path === 'string' ? op.path : null
    const values: Record<string, unknown> = path ? { [path]: op.value } : (typeof op.value === 'object' && op.value !== null ? op.value as Record<string, unknown> : {})
    for (const [key, value] of Object.entries(values)) {
      if (key.toLowerCase() === 'active') {
        const b = kind === 'remove' ? false : scimBoolean(value)
        if (b === undefined) throw scimError(400, '"active" must be true or false.', 'invalidValue')
        active = b
      } else if (key.toLowerCase() === 'externalid') {
        externalId = kind === 'remove' ? null : typeof value === 'string' ? value.slice(0, 255) : undefined
      }
    }
  }
  if (externalId !== undefined) await setIdentityScimExternalId(identity.id, externalId)
  if (active !== undefined) await setScimUserActive(connection, identity, active)
}

export async function replaceScimUser(connection: SsoConnectionRow, identity: UserIdentityRow, body: Record<string, unknown>): Promise<void> {
  if (typeof body.externalId === 'string') await setIdentityScimExternalId(identity.id, body.externalId.slice(0, 255))
  const active = scimBoolean(body.active)
  if (active !== undefined) await setScimUserActive(connection, identity, active)
}

export async function requireScimIdentity(connection: SsoConnectionRow, rawId: string | undefined): Promise<UserIdentityRow> {
  const id = Number(rawId)
  const identity = Number.isInteger(id) && id > 0 ? await findIdentityById(connection.id, id) : null
  if (!identity) throw scimError(404, 'User not found.')
  return identity
}

/**
 * A SCIM route: errors leave as the SCIM Error object (RFC 7644 §3.12),
 * not Nitro's error envelope; anything unexpected is a generic 500
 * (details only in the server log).
 */
export function defineScimHandler<T>(fn: (event: H3Event, connection: SsoConnectionRow) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      const connection = await requireScimConnection(event)
      return await fn(event, connection)
    } catch (e) {
      const data = (e as { data?: { schemas?: string[], status?: string } }).data
      setHeader(event, 'content-type', 'application/scim+json; charset=utf-8')
      if (data?.schemas?.includes(SCIM_ERROR_SCHEMA)) {
        setResponseStatus(event, Number(data.status))
        return data
      }
      console.error('[scim] request failed:', e instanceof Error ? e.message : e)
      setResponseStatus(event, 500)
      return { schemas: [SCIM_ERROR_SCHEMA], status: '500', detail: 'Something went wrong on our side.' }
    }
  })
}

export async function readScimBody(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readBody(event).catch(() => null)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw scimError(400, 'The request body must be a JSON object.', 'invalidSyntax')
  return body as Record<string, unknown>
}
