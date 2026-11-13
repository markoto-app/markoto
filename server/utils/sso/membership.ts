// Joining a workspace without an invitation: on first sign-in through its IdP
// (JIT) and when SCIM creates a user. Same limits as an invitation:
//
//   - the plan's member limit (`membersPerWorkspace`), and for a paid
//     Team / Business workspace its seats (members + open invitations).
//     No seat is bought automatically: a full workspace answers
//     `sso/no-seat` and an admin adds seats on the Billing tab.
//   - An open invitation for the address is used: its role wins, it is
//     deleted, and its already-counted seat is the one taken.
//
// Runs in one transaction under a per-workspace advisory lock
// (`joinWorkspaceWithoutInvite`), so two simultaneous first sign-ins can't
// both take the last seat.

import { joinWorkspaceWithoutInvite } from '../../repos/ssoMembership'
import type { SsoActor } from '../../repos/sso'
import { getPooledWorkspace } from '../billing/workspaceBilling'
import { resolveWorkspacePlan } from '../billing/entitlements'
import { getTiers } from '../billing/tierConfig'
import { wouldExceed } from '~~/shared/config/tiers'
import type { MembershipRole } from '~~/shared/utils/documents/docPermissions'

export class SsoJoinRefused extends Error {
  constructor(public readonly code: 'sso/no-seat' | 'sso/member-limit', message: string) {
    super(message)
    this.name = 'SsoJoinRefused'
  }
}

export interface SsoJoinResult {
  role: MembershipRole
  /** False when the user was already a member. */
  joined: boolean
}

export async function joinWorkspaceBySso(args: {
  /** The SSO sign-in (`system('sso-login')`) or the SCIM client's workspace proof. */
  by: SsoActor
  workspaceId: string
  userId: number
  email: string | null
  defaultRole: 'editor' | 'viewer'
  now?: Date
}): Promise<SsoJoinResult> {
  const now = args.now ?? new Date()
  // Outside the transaction: these read config + the subscription row.
  const pool = await getPooledWorkspace(args.workspaceId, now)
  const memberLimit = getTiers()[await resolveWorkspacePlan(args.workspaceId)].membersPerWorkspace

  return joinWorkspaceWithoutInvite(args.by, { workspaceId: args.workspaceId, userId: args.userId, email: args.email, defaultRole: args.defaultRole, now }, (used) => {
    if (wouldExceed(memberLimit, used)) {
      throw new SsoJoinRefused('sso/member-limit', 'This workspace has reached the member limit of its plan.')
    }
    if (pool && used >= pool.seats) {
      throw new SsoJoinRefused('sso/no-seat', `All ${pool.seats} paid seats of this workspace are taken.`)
    }
  })
}
