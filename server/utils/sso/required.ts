import { getMemberRoleIgnoringSso } from '../../repos/workspaceMembers'
import { getSsoConnectionForWorkspace } from '../../repos/sso'

export const SSO_REQUIRED_CODE = 'sso/required'

/**
 * For a caller who got no role in a workspace: if they ARE a member and
 * the workspace enforces single sign-on (WP14), the 403 that tells the
 * UI where to sign in. Null otherwise (the caller then answers its usual
 * 404, so membership stays hidden from outsiders).
 */
export async function ssoRequiredError(workspaceId: string, userId: number, returnTo?: string): Promise<Error | null> {
  const loginUrl = await ssoLoginUrlForMember(workspaceId, userId, returnTo)
  if (!loginUrl) return null
  // Admins may still manage (and switch off) the connection — the
  // break-glass the UI shows on the sign-in screen.
  const canManageSso = (await getMemberRoleIgnoringSso(workspaceId, userId)) === 'admin'
  return createError({
    statusCode: 403,
    message: 'This workspace uses single sign-on. Sign in through your organisation to continue.',
    data: { code: SSO_REQUIRED_CODE, messageKey: 'sso.required', loginUrl, canManageSso }
  })
}

/** The SSO sign-in link for a member blocked by enforcement, else null. */
export async function ssoLoginUrlForMember(workspaceId: string, userId: number, returnTo?: string): Promise<string | null> {
  if ((await getMemberRoleIgnoringSso(workspaceId, userId)) === null) return null
  const connection = await getSsoConnectionForWorkspace(workspaceId)
  if (!connection || connection.status !== 'active') return null
  const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  return `/auth/sso/${connection.id}${q}`
}
