import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { ssoConnections, ssoDomains, ssoGrants, userIdentities, users } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { DuplicateError, NotFoundError } from './errors'
import { HOUR_MS } from '~~/shared/config/units'

// Per-workspace single sign-on: connections, domains, identities
// and the grants that let a member in while SSO is enforced.

type Db = ReturnType<typeof useDatabase>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

export type SsoProtocol = 'oidc' | 'saml'
export type SsoStatus = 'draft' | 'active'
export type SsoDefaultRole = 'editor' | 'viewer'

export interface SsoConnectionRow {
  id: string
  workspaceId: string
  protocol: SsoProtocol
  status: SsoStatus
  oidcIssuer: string | null
  oidcClientId: string | null
  /** Encrypted; decrypt only where the token exchange needs it. */
  oidcClientSecret: string | null
  samlIdpEntityId: string | null
  samlSsoUrl: string | null
  samlIdpCert: string | null
  defaultRole: SsoDefaultRole
  hasScimToken: boolean
  activatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const connectionColumns = {
  id: ssoConnections.id,
  workspaceId: ssoConnections.workspaceId,
  protocol: ssoConnections.protocol,
  status: ssoConnections.status,
  oidcIssuer: ssoConnections.oidcIssuer,
  oidcClientId: ssoConnections.oidcClientId,
  oidcClientSecret: ssoConnections.oidcClientSecret,
  samlIdpEntityId: ssoConnections.samlIdpEntityId,
  samlSsoUrl: ssoConnections.samlSsoUrl,
  samlIdpCert: ssoConnections.samlIdpCert,
  defaultRole: ssoConnections.defaultRole,
  hasScimToken: sql<boolean>`${ssoConnections.scimTokenHash} is not null`,
  activatedAt: ssoConnections.activatedAt,
  createdAt: ssoConnections.createdAt,
  updatedAt: ssoConnections.updatedAt
}

export async function getSsoConnectionById(id: string, db: DbOrTx = useDatabase()): Promise<SsoConnectionRow | null> {
  return (await db.select(connectionColumns).from(ssoConnections).where(eq(ssoConnections.id, id)).limit(1))[0] ?? null
}

export async function getSsoConnectionForWorkspace(workspaceId: string, db: DbOrTx = useDatabase()): Promise<SsoConnectionRow | null> {
  return (await db.select(connectionColumns).from(ssoConnections).where(eq(ssoConnections.workspaceId, workspaceId)).limit(1))[0] ?? null
}

export async function getSsoConnectionByScimTokenHash(hash: string): Promise<SsoConnectionRow | null> {
  return (await useDatabase().select(connectionColumns).from(ssoConnections).where(eq(ssoConnections.scimTokenHash, hash)).limit(1))[0] ?? null
}

export interface SsoConnectionFields {
  protocol: SsoProtocol
  oidcIssuer?: string | null
  oidcClientId?: string | null
  /** Encrypted. `undefined` = keep the stored one. */
  oidcClientSecret?: string | null
  samlIdpEntityId?: string | null
  samlSsoUrl?: string | null
  samlIdpCert?: string | null
  defaultRole?: SsoDefaultRole
}

/**
 * Create the workspace's connection, or update it. Any change to the
 * IdP settings sends an active connection back to `draft`: the new
 * settings must pass a test sign-in before they are enforced, so a typo
 * can't lock the workspace out.
 */
export async function upsertSsoConnection(args: {
  id: string
  workspaceId: string
  createdByUserId: number
  fields: SsoConnectionFields
}): Promise<{ connection: SsoConnectionRow, idpChanged: boolean }> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const existing = (await tx.select(connectionColumns).from(ssoConnections)
      .where(eq(ssoConnections.workspaceId, args.workspaceId)).for('update').limit(1))[0]
    const f = args.fields
    const idp = {
      protocol: f.protocol,
      oidcIssuer: f.protocol === 'oidc' ? f.oidcIssuer ?? null : null,
      oidcClientId: f.protocol === 'oidc' ? f.oidcClientId ?? null : null,
      samlIdpEntityId: f.protocol === 'saml' ? f.samlIdpEntityId ?? null : null,
      samlSsoUrl: f.protocol === 'saml' ? f.samlSsoUrl ?? null : null,
      samlIdpCert: f.protocol === 'saml' ? f.samlIdpCert ?? null : null
    }
    if (!existing) {
      await tx.insert(ssoConnections).values({
        id: args.id,
        workspaceId: args.workspaceId,
        ...idp,
        oidcClientSecret: f.protocol === 'oidc' ? f.oidcClientSecret ?? null : null,
        defaultRole: f.defaultRole ?? 'editor',
        createdByUserId: args.createdByUserId
      })
      return { connection: (await getSsoConnectionById(args.id, tx))!, idpChanged: true }
    }
    const secretChanged = f.protocol === 'oidc' && f.oidcClientSecret !== undefined && f.oidcClientSecret !== existing.oidcClientSecret
    const idpChanged = secretChanged
      || idp.protocol !== existing.protocol
      || idp.oidcIssuer !== existing.oidcIssuer
      || idp.oidcClientId !== existing.oidcClientId
      || idp.samlIdpEntityId !== existing.samlIdpEntityId
      || idp.samlSsoUrl !== existing.samlSsoUrl
      || idp.samlIdpCert !== existing.samlIdpCert
    await tx.update(ssoConnections).set({
      ...idp,
      ...(f.protocol !== 'oidc' ? { oidcClientSecret: null } : f.oidcClientSecret !== undefined ? { oidcClientSecret: f.oidcClientSecret } : {}),
      ...(f.defaultRole ? { defaultRole: f.defaultRole } : {}),
      ...(idpChanged ? { status: 'draft' as const, activatedAt: null } : {}),
      updatedAt: new Date()
    }).where(eq(ssoConnections.id, existing.id))
    // Switching protocol (or IdP) makes the old identities meaningless.
    if (idp.protocol !== existing.protocol || idp.oidcIssuer !== existing.oidcIssuer || idp.samlIdpEntityId !== existing.samlIdpEntityId) {
      await tx.delete(userIdentities).where(eq(userIdentities.connectionId, existing.id))
    }
    return { connection: (await getSsoConnectionById(existing.id, tx))!, idpChanged }
  })
}

export async function activateSsoConnection(id: string): Promise<void> {
  await useDatabase().update(ssoConnections)
    .set({ status: 'active', activatedAt: new Date(), updatedAt: new Date() })
    .where(eq(ssoConnections.id, id))
}

export async function deleteSsoConnection(workspaceId: string): Promise<boolean> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(ssoConnections).where(eq(ssoConnections.workspaceId, workspaceId)).returning({ id: ssoConnections.id })
    await tx.delete(ssoGrants).where(eq(ssoGrants.workspaceId, workspaceId))
    return deleted.length > 0
  })
}

export async function setScimTokenHash(connectionId: string, hash: string | null): Promise<void> {
  await useDatabase().update(ssoConnections).set({ scimTokenHash: hash, updatedAt: new Date() }).where(eq(ssoConnections.id, connectionId))
}

export interface SsoDomainRow {
  id: number
  domain: string
  verificationToken: string
  verifiedAt: Date | null
}

const domainColumns = {
  id: ssoDomains.id,
  domain: ssoDomains.domain,
  verificationToken: ssoDomains.verificationToken,
  verifiedAt: ssoDomains.verifiedAt
}

export async function listSsoDomains(workspaceId: string): Promise<SsoDomainRow[]> {
  return useDatabase().select(domainColumns).from(ssoDomains)
    .where(eq(ssoDomains.workspaceId, workspaceId)).orderBy(ssoDomains.domain)
}

export async function addSsoDomain(workspaceId: string, domain: string, verificationToken: string): Promise<SsoDomainRow> {
  const rows = await useDatabase().insert(ssoDomains).values({ workspaceId, domain, verificationToken })
    .onConflictDoNothing({ target: [ssoDomains.workspaceId, ssoDomains.domain] })
    .returning(domainColumns)
  if (!rows[0]) throw new DuplicateError('This domain is already listed for the workspace.')
  return rows[0]
}

export async function getSsoDomain(workspaceId: string, id: number): Promise<SsoDomainRow | null> {
  return (await useDatabase().select(domainColumns).from(ssoDomains)
    .where(and(eq(ssoDomains.workspaceId, workspaceId), eq(ssoDomains.id, id))).limit(1))[0] ?? null
}

/** Mark verified. DuplicateError when another workspace verified it first. */
export async function markSsoDomainVerified(workspaceId: string, id: number): Promise<void> {
  try {
    const rows = await useDatabase().update(ssoDomains).set({ verifiedAt: new Date() })
      .where(and(eq(ssoDomains.workspaceId, workspaceId), eq(ssoDomains.id, id))).returning({ id: ssoDomains.id })
    if (!rows[0]) throw new NotFoundError('Domain not found.')
  } catch (e) {
    if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new DuplicateError('Another workspace has already verified this domain.')
    }
    throw e
  }
}

export async function deleteSsoDomain(workspaceId: string, id: number): Promise<boolean> {
  const rows = await useDatabase().delete(ssoDomains)
    .where(and(eq(ssoDomains.workspaceId, workspaceId), eq(ssoDomains.id, id))).returning({ id: ssoDomains.id })
  return rows.length > 0
}

/** The workspace that verified `domain`, if any. */
export async function findVerifiedDomainOwner(domain: string): Promise<string | null> {
  return (await useDatabase().select({ workspaceId: ssoDomains.workspaceId }).from(ssoDomains)
    .where(and(eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt))).limit(1))[0]?.workspaceId ?? null
}

export async function isDomainVerifiedForWorkspace(workspaceId: string, domain: string, db: DbOrTx = useDatabase()): Promise<boolean> {
  const row = (await db.select({ id: ssoDomains.id }).from(ssoDomains)
    .where(and(eq(ssoDomains.workspaceId, workspaceId), eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt))).limit(1))[0]
  return row !== undefined
}

export interface UserIdentityRow {
  id: number
  userId: number
  subject: string
  scimExternalId: string | null
  active: boolean
}

const identityColumns = {
  id: userIdentities.id,
  userId: userIdentities.userId,
  subject: userIdentities.subject,
  scimExternalId: userIdentities.scimExternalId,
  active: userIdentities.active
}

export async function findIdentity(connectionId: string, subject: string, db: DbOrTx = useDatabase()): Promise<UserIdentityRow | null> {
  return (await db.select(identityColumns).from(userIdentities)
    .where(and(eq(userIdentities.connectionId, connectionId), eq(userIdentities.subject, subject))).limit(1))[0] ?? null
}

export async function findIdentityForUser(connectionId: string, userId: number, db: DbOrTx = useDatabase()): Promise<UserIdentityRow | null> {
  return (await db.select(identityColumns).from(userIdentities)
    .where(and(eq(userIdentities.connectionId, connectionId), eq(userIdentities.userId, userId))).limit(1))[0] ?? null
}

export async function findIdentityById(connectionId: string, id: number): Promise<UserIdentityRow | null> {
  return (await useDatabase().select(identityColumns).from(userIdentities)
    .where(and(eq(userIdentities.connectionId, connectionId), eq(userIdentities.id, id))).limit(1))[0] ?? null
}

export async function insertIdentity(args: { userId: number, connectionId: string, subject: string, scimExternalId?: string | null }, db: DbOrTx = useDatabase()): Promise<UserIdentityRow> {
  const rows = await db.insert(userIdentities).values({
    userId: args.userId,
    connectionId: args.connectionId,
    subject: args.subject,
    scimExternalId: args.scimExternalId ?? null
  }).onConflictDoNothing().returning(identityColumns)
  if (!rows[0]) throw new DuplicateError('This identity is already linked.')
  return rows[0]
}

export async function touchIdentityLogin(id: number, db: DbOrTx = useDatabase()): Promise<void> {
  await db.update(userIdentities).set({ lastLoginAt: new Date() }).where(eq(userIdentities.id, id))
}

export async function setIdentityActive(id: number, active: boolean, db: DbOrTx = useDatabase()): Promise<void> {
  await db.update(userIdentities).set({ active }).where(eq(userIdentities.id, id))
}

export async function setIdentityScimExternalId(id: number, externalId: string | null, db: DbOrTx = useDatabase()): Promise<void> {
  await db.update(userIdentities).set({ scimExternalId: externalId }).where(eq(userIdentities.id, id))
}

/** How long a sign-in through the workspace's IdP lets the member in. */
const SSO_GRANT_TTL_MS = 12 * HOUR_MS

export async function writeSsoGrant(userId: number, workspaceId: string, sessionEpoch: number, now = new Date(), db: DbOrTx = useDatabase()): Promise<void> {
  const expiresAt = new Date(now.getTime() + SSO_GRANT_TTL_MS)
  await db.insert(ssoGrants).values({ userId, workspaceId, sessionEpoch, grantedAt: now, expiresAt })
    .onConflictDoUpdate({ target: [ssoGrants.userId, ssoGrants.workspaceId], set: { sessionEpoch, grantedAt: now, expiresAt } })
}

export async function deleteSsoGrant(userId: number, workspaceId: string, db: DbOrTx = useDatabase()): Promise<void> {
  await db.delete(ssoGrants).where(and(eq(ssoGrants.userId, userId), eq(ssoGrants.workspaceId, workspaceId)))
}

/**
 * SQL condition: the user may use their membership of the workspace —
 * there is no ACTIVE connection, or they hold a current grant (unexpired,
 * written in their current session epoch). Used inside every query that
 * turns membership into access (`getMemberRole`, `getDocWithActorRole`).
 */
export function ssoSatisfiedSql(workspaceIdColumn: AnyPgColumn | SQL, userId: number | SQL): SQL {
  return sql`(
    not exists (select 1 from ${ssoConnections} sc where sc.workspace_id = ${workspaceIdColumn} and sc.status = 'active')
    or exists (
      select 1 from ${ssoGrants} sg join ${users} su on su.id = sg.user_id
      where sg.workspace_id = ${workspaceIdColumn} and sg.user_id = ${userId}
        and sg.expires_at > now() and sg.session_epoch = su.session_epoch
    )
  )`
}

/**
 * SQL condition: the workspace enforces single sign-on (has an ACTIVE
 * connection). False for a NULL workspace id (standalone documents).
 */
export function ssoEnforcedSql(workspaceIdColumn: AnyPgColumn | SQL): SQL {
  return sql`exists (select 1 from ${ssoConnections} sc where sc.workspace_id = ${workspaceIdColumn} and sc.status = 'active')`
}
