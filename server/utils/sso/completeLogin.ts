// Per-workspace SSO (WP14) — what happens after the IdP vouched for
// someone. Protocol-independent: the OIDC callback and the SAML ACS both
// hand over a validated `SsoAssertion` and the decoded flow cookie.
//
// Who is this? (one transaction, row locks)
//   1. A known identity (connection, subject) → its user. A SCIM-
//      deactivated identity is refused.
//   2. An admin's TEST sign-in → the identity is linked to that admin
//      (they are signed in to markoto already and started the test).
//   3. The email is in a domain the workspace VERIFIED → the existing
//      account with that address gets the identity, else a new account
//      is created with it. (The workspace proved it owns the domain, so
//      its IdP may speak for addresses in it — the user's choice
//      "link if domain verified".)
//   4. Anything else → `sso/not-provisioned`. No unverified address is
//      ever matched against an existing account.
//
// Member of the workspace?
//   - already a member → fine; otherwise a verified-domain address or a
//     SCIM-provisioned identity joins (seats + member limit,
//     `membership.ts`); otherwise `sso/not-provisioned`.
//
// Then: a 12 h grant for the user's current session epoch (what lets
// them in while SSO is enforced), and for a successful test the
// connection becomes active.
//
// Never: instance admin bootstrap (`NUXT_ADMIN_USER_EMAILS`) — a
// customer's IdP must not be able to make anyone an instance operator.

import { and, eq, sql } from 'drizzle-orm'
import { userIdentities, users } from '../../db/schema'
import { useDatabase } from '../platform/database'
import {
  activateSsoConnection,
  findIdentity,
  findIdentityForUser,
  insertIdentity,
  isDomainVerifiedForWorkspace,
  touchIdentityLogin,
  writeSsoGrant,
  type SsoConnectionRow
} from '../../repos/sso'
import { getMemberRoleIgnoringSso, getMembershipRole } from '../../repos/workspaceMembers'
import { getSessionEpoch } from '../../repos/users'
import { emailDomain } from './domains'
import { joinWorkspaceBySso, SsoJoinRefused } from './membership'
import type { SsoFlow } from './flowCookie'
import { SCIM_PLACEHOLDER_PREFIX } from './scimPrefix'
import type { MembershipRole } from '~~/shared/utils/documents/docPermissions'

export interface SsoAssertion {
  /** OIDC `sub` / SAML NameID. */
  subject: string
  email: string | null
  /** The IdP said the address is verified (OIDC `email_verified`). */
  emailVerified: boolean
  name: string
}

export type SsoRefusalCode
  = | 'sso/not-provisioned'
    | 'sso/deactivated'
    | 'sso/not-active'
    | 'sso/test-not-admin'
    | 'sso/test-mismatch'
    | 'sso/no-seat'
    | 'sso/member-limit'

export class SsoLoginRefused extends Error {
  constructor(public readonly code: SsoRefusalCode, message: string) {
    super(message)
    this.name = 'SsoLoginRefused'
  }
}

export interface SsoLoginResult {
  userId: number
  name: string
  email: string | null
  workspaceId: string
  role: MembershipRole
  /** The account was created by this sign-in. */
  created: boolean
  /** The identity was linked to an account by this sign-in. */
  linked: boolean
  /** The user joined the workspace by this sign-in. */
  joined: boolean
  /** A test sign-in activated the connection. */
  activated: boolean
}

const MAX_NAME = 200

export async function completeSsoLogin(connection: SsoConnectionRow, assertion: SsoAssertion, flow: SsoFlow): Promise<SsoLoginResult> {
  if (flow.connectionId !== connection.id) throw new SsoLoginRefused('sso/not-provisioned', 'The sign-in belongs to another connection.')
  const isTest = flow.purpose === 'test'
  if (!isTest && connection.status !== 'active') {
    throw new SsoLoginRefused('sso/not-active', 'Single sign-on for this workspace is not switched on yet.')
  }
  if (isTest && (await getMemberRoleIgnoringSso(connection.workspaceId, flow.testUserId!)) !== 'admin') {
    throw new SsoLoginRefused('sso/test-not-admin', 'Only an admin of the workspace can test its sign-in.')
  }

  // The IdP may only speak for addresses in a domain the workspace verified.
  const domain = emailDomain(assertion.email)
  const trustedEmail = assertion.email && domain && await isDomainVerifiedForWorkspace(connection.workspaceId, domain)
    ? assertion.email.trim().toLowerCase()
    : null
  const name = (assertion.name || trustedEmail || 'Workspace member').slice(0, MAX_NAME)

  const who = await useDatabase().transaction(async (tx) => {
    const identity = await findIdentity(connection.id, assertion.subject, tx)
    if (identity) {
      if (!identity.active) throw new SsoLoginRefused('sso/deactivated', 'Your access to this workspace was removed by your organisation.')
      if (isTest && identity.userId !== flow.testUserId) {
        throw new SsoLoginRefused('sso/test-mismatch', 'This identity-provider account belongs to another markoto account. Test with your own account.')
      }
      return { userId: identity.userId, identityId: identity.id, scim: identity.scimExternalId !== null, created: false, linked: false }
    }

    let userId: number
    let created = false
    if (isTest) {
      userId = flow.testUserId!
    } else if (trustedEmail) {
      const existing = (await tx.execute<{ id: number }>(sql`
        select id from ${users} where lower(email) = ${trustedEmail} order by id limit 1 for update
      `)).rows[0]
      if (existing) {
        userId = Number(existing.id)
      } else {
        const inserted = await tx.insert(users).values({ name, email: trustedEmail }).returning({ id: users.id })
        userId = inserted[0]!.id
        created = true
      }
    } else {
      throw new SsoLoginRefused('sso/not-provisioned', 'Your account is not set up for this workspace. Ask an admin to add you.')
    }
    // One identity per account and connection. A SCIM-provisioned
    // placeholder (`scim:…`) is taken over by the first real sign-in;
    // an account linked to ANOTHER real subject is not re-linked.
    const linkedAlready = await findIdentityForUser(connection.id, userId, tx)
    if (linkedAlready?.subject.startsWith(SCIM_PLACEHOLDER_PREFIX)) {
      if (!linkedAlready.active) throw new SsoLoginRefused('sso/deactivated', 'Your access to this workspace was removed by your organisation.')
      await tx.update(userIdentities).set({ subject: assertion.subject }).where(eq(userIdentities.id, linkedAlready.id))
      return { userId, identityId: linkedAlready.id, scim: true, created, linked: true }
    }
    if (linkedAlready) {
      throw new SsoLoginRefused(isTest ? 'sso/test-mismatch' : 'sso/not-provisioned', 'This markoto account is linked to another account at your identity provider.')
    }
    const inserted = await insertIdentity({ userId, connectionId: connection.id, subject: assertion.subject }, tx)
    return { userId, identityId: inserted.id, scim: false, created, linked: true }
  })

  // Raw membership incl. `guest` (WP11): an existing guest stays a guest.
  let role: MembershipRole | null = await getMembershipRole(connection.workspaceId, who.userId)
  let joined = false
  if (!role) {
    if (!trustedEmail && !who.scim) {
      throw new SsoLoginRefused('sso/not-provisioned', 'Your account is not a member of this workspace. Ask an admin to add you.')
    }
    try {
      const result = await joinWorkspaceBySso({ workspaceId: connection.workspaceId, userId: who.userId, email: trustedEmail, defaultRole: connection.defaultRole })
      role = result.role
      joined = result.joined
    } catch (e) {
      if (e instanceof SsoJoinRefused) throw new SsoLoginRefused(e.code, e.message)
      throw e
    }
  }

  await touchIdentityLogin(who.identityId)
  await writeSsoGrant(who.userId, connection.workspaceId, await getSessionEpoch(who.userId))
  let activated = false
  if (isTest && connection.status !== 'active') {
    await activateSsoConnection(connection.id)
    activated = true
  }

  const profile = (await useDatabase().select({ name: users.name, email: users.email }).from(users)
    .where(and(eq(users.id, who.userId))).limit(1))[0]
  return {
    userId: who.userId,
    name: profile?.name ?? name,
    email: profile?.email ?? null,
    workspaceId: connection.workspaceId,
    role,
    created: who.created,
    linked: who.linked,
    joined,
    activated
  }
}
