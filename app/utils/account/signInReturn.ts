import type { LoginProvider } from '~~/shared/config/instance'

const LINKABLE: readonly LoginProvider[] = ['github', 'google', 'oidc']

export interface SignInMarkers {
  /** A second provider was added to an existing account. */
  linked: LoginProvider | null
}

/** The markers a completed sign-in put on the address, or null when this load is not one. */
export function signInMarkers(params: URLSearchParams): SignInMarkers | null {
  if (params.get('signed_in') !== '1') return null
  const linked = params.get('linked')
  return { linked: LINKABLE.find(p => p === linked) ?? null }
}

/** How many adopted documents to announce (0: no toast). */
export function adoptedToast(adopted: unknown): number {
  return typeof adopted === 'number' && Number.isInteger(adopted) && adopted > 0 ? adopted : 0
}
