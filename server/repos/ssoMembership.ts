import { and, eq, gt, ilike, sql } from 'drizzle-orm'
import { users, userIdentities, ssoConnections, workspaceInvites, workspaceMembers } from '../db/schema'
import { executor, useDatabase, type TxHandle } from '../db/client'
import type { MembershipRole } from '../../shared/utils/documents/docPermissions'
import { must } from '~~/shared/utils/must'
import type { SsoActor } from './sso'
import type { WorkspaceAccess } from './proofs'

// Writes of the SSO sign-in and of SCIM provisioning that touch accounts and
// memberships: finding or creating the account for a verified address,
// joining a workspace without an invitation, the SCIM user listing. Only the
// SSO actors run them (`system('sso-login')`, a SCIM client's proof).

/**
 * The account with this verified address (row-locked for the rest of `tx`),
 * else a new one. Lowest id wins when several share the address.
 */
export async function findOrCreateUserByEmail(_by: SsoActor, email: string, name: string, tx?: TxHandle): Promise<{ userId: number, created: boolean }> {
  const db = executor(tx)
  const existing = (await db.execute<{ id: number }>(sql`select id from ${users} where lower(email) = ${email} order by id limit 1 for update`)).rows[0]
  if (existing) return { userId: Number(existing.id), created: false }
  const inserted = await db.insert(users).values({ name, email }).returning({ id: users.id })
  return { userId: must(inserted[0], 'inserted user row').id, created: true }
}

/** A SCIM placeholder identity taken over by the user's first real sign-in. */
export async function setIdentitySubject(_by: SsoActor, identityId: number, subject: string, tx?: TxHandle): Promise<void> {
  await executor(tx).update(userIdentities).set({ subject }).where(eq(userIdentities.id, identityId))
}

export async function deleteIdentity(_by: SsoActor, identityId: number): Promise<void> {
  await useDatabase().delete(userIdentities).where(eq(userIdentities.id, identityId))
}

/**
 * Join a workspace without an invitation (first SSO sign-in, SCIM create),
 * serialised per workspace with the invitations' seat lock. An open
 * invitation for the address is used (its role wins, it is deleted, its
 * already-counted seat is the one taken). Without one, `admit(used)` decides
 * on the people in the workspace (members + open invitations, guests not
 * counted) and throws to refuse.
 */
export async function joinWorkspaceWithoutInvite(
  _by: SsoActor,
  args: { workspaceId: string, userId: number, email: string | null, defaultRole: 'editor' | 'viewer', now: Date },
  admit: (used: number) => void
): Promise<{ role: MembershipRole, joined: boolean }> {
  return useDatabase().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace-seats:${args.workspaceId}`}))`)
    const existing = (await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, args.workspaceId), eq(workspaceMembers.userId, args.userId))).limit(1))[0]
    if (existing) return { role: existing.role, joined: false }

    const invite = args.email
      ? (await tx.select({ id: workspaceInvites.id, role: workspaceInvites.role }).from(workspaceInvites)
          .where(and(
            eq(workspaceInvites.workspaceId, args.workspaceId),
            eq(workspaceInvites.email, args.email.trim().toLowerCase()),
            gt(workspaceInvites.expiresAt, args.now)
          )).limit(1))[0]
      : undefined

    if (!invite) {
      const counts = (await tx.execute<{ members: number, invites: number }>(sql`
        select
          (select count(*)::int from ${workspaceMembers} where workspace_id = ${args.workspaceId} and role <> 'guest') as members,
          (select count(*)::int from ${workspaceInvites} where workspace_id = ${args.workspaceId} and expires_at > ${args.now} and role <> 'guest') as invites
      `)).rows[0] ?? { members: 0, invites: 0 }
      admit(Number(counts.members) + Number(counts.invites))
    }

    const role: MembershipRole = invite?.role ?? args.defaultRole
    await tx.insert(workspaceMembers).values({ workspaceId: args.workspaceId, userId: args.userId, role })
      .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
    if (invite) await tx.delete(workspaceInvites).where(eq(workspaceInvites.id, invite.id))
    return { role, joined: true }
  })
}

export interface ScimUserRow {
  id: number
  userId: number
  externalId: string | null
  active: boolean
  email: string | null
  name: string
  subject: string
}

const scimUserColumns = {
  id: userIdentities.id,
  userId: userIdentities.userId,
  externalId: userIdentities.scimExternalId,
  active: userIdentities.active,
  email: users.email,
  name: users.name,
  subject: userIdentities.subject
}

/** Identities of the SCIM client's own workspace's connection only. */
function inWorkspace(ws: WorkspaceAccess<'admin'>, connectionId: string) {
  return and(
    eq(userIdentities.connectionId, connectionId),
    sql`exists (select 1 from ${ssoConnections} sc where sc.id = ${userIdentities.connectionId} and sc.workspace_id = ${ws.workspaceId})`
  )
}

export async function getScimUser(ws: WorkspaceAccess<'admin'>, connectionId: string, id: number): Promise<ScimUserRow | null> {
  return (await useDatabase().select(scimUserColumns).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(inWorkspace(ws, connectionId), eq(userIdentities.id, id))).limit(1))[0] ?? null
}

/** A page of the connection's users, optionally filtered by external id or (case-insensitive) email. */
export async function listScimUsers(
  ws: WorkspaceAccess<'admin'>,
  connectionId: string,
  opts: { filter: { attribute: 'userName' | 'externalId', value: string } | null, offset: number, limit: number }
): Promise<{ total: number, rows: ScimUserRow[] }> {
  const db = useDatabase()
  const conditions = [inWorkspace(ws, connectionId)]
  if (opts.filter) {
    conditions.push(opts.filter.attribute === 'externalId'
      ? eq(userIdentities.scimExternalId, opts.filter.value)
      : ilike(users.email, opts.filter.value.replace(/[%_\\]/g, m => `\\${m}`)))
  }
  const where = and(...conditions)
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId)).where(where))[0]?.n ?? 0)
  const rows = await db.select(scimUserColumns).from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId)).where(where)
    .orderBy(userIdentities.id)
    .offset(opts.offset).limit(opts.limit)
  return { total, rows }
}
