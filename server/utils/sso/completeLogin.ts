// What happens after the IdP vouched for someone. Protocol-independent: the
// OIDC callback and the SAML ACS both hand over a validated `SsoAssertion`
// and the decoded flow cookie.
//
// Who is this? (one transaction, row locks)
//   1. A known identity (connection, subject) maps to its user. A
//      SCIM-deactivated identity is refused.
//   2. An admin's TEST sign-in links the identity to that admin (already
//      signed in to markoto, they started the test).
//   3. The email is in a domain the workspace verified: the existing account
//      with that address gets the identity, else a new account is created.
//      Verification proves the workspace owns the domain, so its IdP may
//      speak for addresses in it.
//   4. Anything else is `sso/not-provisioned`. An unverified address is never
//      matched against an existing account.
//
// Member of the workspace? An existing member passes; otherwise a
// verified-domain address or a SCIM-provisioned identity joins (seats +
// member limit, `membership.ts`); otherwise `sso/not-provisioned`.
//
// Then a 12 h grant for the user's current session epoch is written (it lets
// them in while SSO is enforced), and a successful test activates the
// connection.
//
// Never instance-admin bootstrap (`NUXT_ADMIN_USER_EMAILS`): a customer's IdP
// must not be able to make anyone an instance operator.

import { findOrCreateUserByEmail, setIdentitySubject } from '../../repos/ssoMembership'
import { findUserById, getSessionEpoch } from '../../repos/users'
import { withTransaction, type TxHandle } from '../../repos/transaction'
import { system } from '../../repos/proofs'
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
import { getMemberRoleIgnoringSso, getMembershipRole } from '../access/workspaceAccess'
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
  const testUserId = await admitFlow(connection, flow)
  const isTest = testUserId !== null

  // The IdP may only speak for addresses in a domain the workspace verified.
  const domain = emailDomain(assertion.email)
  const trustedEmail = assertion.email && domain && await isDomainVerifiedForWorkspace(connection.workspaceId, domain)
    ? assertion.email.trim().toLowerCase()
    : null
  const name = (assertion.name || trustedEmail || 'Workspace member').slice(0, MAX_NAME)

  const who = await withTransaction(async (tx) => {
    const identity = await findIdentity(connection.id, assertion.subject, tx)
    if (identity) {
      if (!identity.active) throw new SsoLoginRefused('sso/deactivated', 'Your access to this workspace was removed by your organisation.')
      if (isTest && identity.userId !== testUserId) {
        throw new SsoLoginRefused('sso/test-mismatch', 'This identity-provider account belongs to another markoto account. Test with your own account.')
      }
      return { userId: identity.userId, identityId: identity.id, scim: identity.scimExternalId !== null, created: false, linked: false }
    }
    const account = testUserId === null
      ? await accountForEmail(tx, trustedEmail, name)
      : { userId: testUserId, created: false }
    return linkIdentity(tx, connection, assertion.subject, account, isTest)
  })

  const { role, joined } = await ensureMembership(connection, who, trustedEmail)
  await touchIdentityLogin(SSO_LOGIN, who.identityId)
  await writeSsoGrant(SSO_LOGIN, who.userId, connection.workspaceId, await getSessionEpoch(who.userId))
  let activated = false
  if (isTest && connection.status !== 'active') {
    await activateSsoConnection(SSO_LOGIN, connection.id)
    activated = true
  }

  const profile = await findUserById(SSO_LOGIN.actingFor(who.userId))
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

/** The sign-in through the workspace's IdP acts on whichever account and membership it resolves. */
const SSO_LOGIN = system('sso-login')

/**
 * The flow may sign in with this connection: a test flow names the admin
 * who started it (returned), a real sign-in needs an active connection.
 */
async function admitFlow(connection: SsoConnectionRow, flow: SsoFlow): Promise<number | null> {
  if (flow.connectionId !== connection.id) throw new SsoLoginRefused('sso/not-provisioned', 'The sign-in belongs to another connection.')
  // A test flow always names the admin who started it (the flow cookie
  // refuses one without); without it the test can't be attributed.
  const testUserId = flow.purpose === 'test' ? flow.testUserId ?? null : null
  if (flow.purpose === 'test' && testUserId === null) {
    throw new SsoLoginRefused('sso/test-not-admin', 'Only an admin of the workspace can test its sign-in.')
  }
  if (testUserId === null && connection.status !== 'active') {
    throw new SsoLoginRefused('sso/not-active', 'Single sign-on for this workspace is not switched on yet.')
  }
  if (testUserId !== null && (await getMemberRoleIgnoringSso(connection.workspaceId, testUserId)) !== 'admin') {
    throw new SsoLoginRefused('sso/test-not-admin', 'Only an admin of the workspace can test its sign-in.')
  }
  return testUserId
}

/** The account a first sign-in belongs to: the one with the verified address, else a new one. */
async function accountForEmail(tx: TxHandle, trustedEmail: string | null, name: string): Promise<{ userId: number, created: boolean }> {
  if (!trustedEmail) {
    throw new SsoLoginRefused('sso/not-provisioned', 'Your account is not set up for this workspace. Ask an admin to add you.')
  }
  return findOrCreateUserByEmail(SSO_LOGIN, trustedEmail, name, tx)
}

/**
 * One identity per account and connection. A SCIM-provisioned
 * placeholder (`scim:…`) is taken over by the first real sign-in;
 * an account linked to ANOTHER real subject is not re-linked.
 */
async function linkIdentity(
  tx: TxHandle,
  connection: SsoConnectionRow,
  subject: string,
  account: { userId: number, created: boolean },
  isTest: boolean
): Promise<{ userId: number, identityId: number, scim: boolean, created: boolean, linked: boolean }> {
  const { userId, created } = account
  const linkedAlready = await findIdentityForUser(connection.id, userId, tx)
  if (linkedAlready?.subject.startsWith(SCIM_PLACEHOLDER_PREFIX)) {
    if (!linkedAlready.active) throw new SsoLoginRefused('sso/deactivated', 'Your access to this workspace was removed by your organisation.')
    await setIdentitySubject(SSO_LOGIN, linkedAlready.id, subject, tx)
    return { userId, identityId: linkedAlready.id, scim: true, created, linked: true }
  }
  if (linkedAlready) {
    throw new SsoLoginRefused(isTest ? 'sso/test-mismatch' : 'sso/not-provisioned', 'This markoto account is linked to another account at your identity provider.')
  }
  const inserted = await insertIdentity(SSO_LOGIN, { userId, connectionId: connection.id, subject }, tx)
  return { userId, identityId: inserted.id, scim: false, created, linked: true }
}

/** Raw membership incl. `guest` (an existing guest stays a guest); otherwise join by verified email or SCIM. */
async function ensureMembership(
  connection: SsoConnectionRow,
  who: { userId: number, scim: boolean },
  trustedEmail: string | null
): Promise<{ role: MembershipRole, joined: boolean }> {
  const role = await getMembershipRole(connection.workspaceId, who.userId)
  if (role) return { role, joined: false }
  if (!trustedEmail && !who.scim) {
    throw new SsoLoginRefused('sso/not-provisioned', 'Your account is not a member of this workspace. Ask an admin to add you.')
  }
  try {
    const result = await joinWorkspaceBySso({ by: SSO_LOGIN, workspaceId: connection.workspaceId, userId: who.userId, email: trustedEmail, defaultRole: connection.defaultRole })
    return { role: result.role, joined: result.joined }
  } catch (e) {
    if (e instanceof SsoJoinRefused) throw new SsoLoginRefused(e.code, e.message)
    throw e
  }
}
