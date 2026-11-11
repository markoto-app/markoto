// Per-workspace SSO (WP14) — joining a workspace without an invitation:
// on the first sign-in through its IdP (JIT) and when SCIM creates a
// user. Same limits as an invitation:
//
//   - the plan's member limit (`membersPerWorkspace`), and for a paid
//     Team / Business workspace its seats (members + open invitations).
//     No seat is ever bought automatically — a full workspace answers
//     `sso/no-seat` and an admin adds seats on the Billing tab.
//   - An open invitation for the address is used: its role wins, it is
//     deleted, and its seat (already counted) is the one taken.
//
// Runs in one transaction under a per-workspace advisory lock, so two
// first sign-ins at the same moment can't both take the last seat.

import { and, eq, gt, sql } from 'drizzle-orm'
import { workspaceInvites, workspaceMembers } from '../../db/schema'
import { useDatabase } from '../platform/database'
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
            gt(workspaceInvites.expiresAt, now)
          )).limit(1))[0]
      : undefined

    if (!invite) {
      const counts = (await tx.execute<{ members: number, invites: number }>(sql`
        select
          (select count(*)::int from ${workspaceMembers} where workspace_id = ${args.workspaceId} and role <> 'guest') as members,
          (select count(*)::int from ${workspaceInvites} where workspace_id = ${args.workspaceId} and expires_at > ${now} and role <> 'guest') as invites
      `)).rows[0] ?? { members: 0, invites: 0 }
      const used = Number(counts.members) + Number(counts.invites)
      if (wouldExceed(memberLimit, used)) {
        throw new SsoJoinRefused('sso/member-limit', 'This workspace has reached the member limit of its plan.')
      }
      if (pool && used >= pool.seats) {
        throw new SsoJoinRefused('sso/no-seat', `All ${pool.seats} paid seats of this workspace are taken.`)
      }
    }

    const role: MembershipRole = invite?.role ?? args.defaultRole
    await tx.insert(workspaceMembers).values({ workspaceId: args.workspaceId, userId: args.userId, role })
      .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
    if (invite) await tx.delete(workspaceInvites).where(eq(workspaceInvites.id, invite.id))
    return { role, joined: true }
  })
}
