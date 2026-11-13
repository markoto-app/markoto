// Verified-email extraction for the GitHub + Google sign-in handlers.
//
// An email is only used, stored on the user row, offered for the
// verified-email account merge, matched against NUXT_ADMIN_USER_EMAILS,
// findable by workspace invites, when the provider says it is verified.
// An unverified address is dropped (stored as NULL), exactly like the
// OIDC handler (`server/utils/oidc/profile.ts`): otherwise anyone able to
// put someone else's address on their provider account unverified could
// inherit that person's admin bootstrap or invitations.

export interface GoogleProfileEmail {
  email?: string | null
  email_verified?: boolean
}

/** Google userinfo: the email only when `email_verified` is the JSON boolean `true`. */
export function googleVerifiedEmail(user: GoogleProfileEmail): string | null {
  return user.email && user.email_verified === true ? user.email : null
}

export interface GitHubProfileEmail {
  email?: string | null
  /** Set by nuxt-auth-utils only when it had to look the primary email up itself. */
  email_verified?: boolean
}

export interface GitHubEmailEntry {
  email: string
  primary: boolean
  verified: boolean
}

/**
 * GitHub: the profile email when GitHub reports it verified. The public
 * profile email carries no verification flag, so it is checked against
 * `/user/emails` (needs the `user:email` scope the handler requests);
 * without a profile email the PRIMARY address is used, again only when
 * verified. Any lookup failure → null (sign-in proceeds without an email).
 */
export async function githubVerifiedEmail(
  user: GitHubProfileEmail,
  listEmails: () => Promise<GitHubEmailEntry[]>
): Promise<string | null> {
  if (user.email && user.email_verified === true) return user.email
  let entries: GitHubEmailEntry[]
  try {
    entries = await listEmails()
  } catch {
    return null
  }
  const wanted = user.email?.toLowerCase() ?? null
  const match = entries.find(e => (wanted ? e.email.toLowerCase() === wanted : e.primary))
  return match && match.verified === true ? match.email : null
}
