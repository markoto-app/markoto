import { planHasFeature, resolveWorkspacePlan } from '../billing/entitlements'

// Who may do what with a workspace's brand kit. Reading the kit (the fonts +
// logos the theme panel offers): any member (`allow.workspace('member')`).
// Changing it: admins, on a plan with the `brandKit` feature. Without the
// feature (e.g. after a downgrade) nothing is deleted: existing fonts, logos
// and templates keep working, the lock pauses, nothing new can be added.

export const BRAND_KIT_PLAN_MESSAGE = 'The brand kit is part of the Team and Business plans.'

export async function brandKitAvailable(wsId: string): Promise<boolean> {
  return planHasFeature(await resolveWorkspacePlan(wsId), 'brandKit')
}
