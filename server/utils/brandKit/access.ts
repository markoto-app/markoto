import type { H3Event } from 'h3'
import { planHasFeature, assertPlanFeature, resolveWorkspacePlan } from '../entitlements'
import type { WorkspaceRole } from '~~/shared/utils/docPermissions'

// Who may do what with a workspace's brand kit (WP10). Normal role checks
// (SSO enforcement applies). Reading the kit (the fonts + logos the theme
// panel offers): any member. Changing it: admins, on a plan with the
// `brandKit` feature. Without the feature (e.g. after a downgrade)
// nothing is deleted: existing fonts, logos and templates keep working,
// the lock pauses, nothing new can be added.

export async function requireBrandKitMember(event: H3Event): Promise<{ userId: number, wsId: string, role: WorkspaceRole }> {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  return { userId: session.user.id, wsId, role }
}

export async function requireBrandKitAdmin(event: H3Event): Promise<{ userId: number, wsId: string }> {
  const ctx = await requireBrandKitMember(event)
  if (ctx.role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only workspace admins can change the brand kit.', data: { code: 'brand/admin-required' } })
  }
  assertPlanFeature(await resolveWorkspacePlan(ctx.wsId), 'brandKit', 'The brand kit is part of the Team and Business plans.')
  return { userId: ctx.userId, wsId: ctx.wsId }
}

export async function brandKitAvailable(wsId: string): Promise<boolean> {
  return planHasFeature(await resolveWorkspacePlan(wsId), 'brandKit')
}
