import type { DocTheme } from '~~/shared/types/theme'
import type { BrandFont } from '~~/shared/config/brandKit'
import type { ApiResponse } from '~/utils/api/client'

/**
 * The access state of one open document, as `useDocToken` keeps it: the JWT
 * in use, the access tier it granted, and the document metadata the token
 * answer seeds before Y.js sync settles. The writers below apply one server
 * answer each, so `useDocToken` holds the flow and this file the fields.
 */

export interface DocTokenState {
  token: string
  readOnly: boolean
}

type TokenAnswer = ApiResponse<'/api/docs/:docId/token', 'get'>
type MetaAnswer = ApiResponse<'/api/docs/:docId/meta', 'get'>

export function createDocAccessState() {
  return {
    // The JWT + readOnly flag in use by the provider. Null = not fetched yet;
    // an empty token = the fetch failed (the user then sees a disconnected
    // state rather than a hang).
    tokenData: ref<DocTokenState | null>(null),
    isReadOnly: ref(false),
    // Set only when the sync layer rejected our auth at handshake time. Both
    // that and a server-declared read-only (`data.readOnly`) flip isReadOnly,
    // but only this one is a fault worth a banner.
    syncAuthFailed: ref(false),
    isOwner: ref(false),
    // Anonymous-created docs have `ownerId: null`: anyone with edit access can
    // change anything, including the theme. Logged-in docs always have an
    // owner, and only that owner gets theme write access.
    hasOwner: ref(false),
    requiresPassword: ref(false),
    // Private doc, non-owner: no token, and no client-side unlock path.
    forbidden: ref(false),
    // Server-computed: would DELETE /api/docs/:id succeed for this caller
    // (owner / workspace admin; for an anonymous doc only its creating browser)?
    canDelete: ref(false),
    // The token endpoint 404'd. Distinct from `forbidden` and from a transient
    // fetch failure, so the editor can show a not-found screen.
    notFound: ref(false),
    accessMode: ref<string>('open-edit'),
    workspaceId: ref<string | null>(null),
    workspaceRole: ref<'admin' | 'editor' | 'viewer' | null>(null),
    // Set while a post-password-verify reconnect is in flight; the orchestrator
    // clears it via `clearPendingUnlock()` once the new provider syncs.
    pendingPasswordUnlock: ref(false),
    // DB-stored theme (null = defaultTheme), returned by /token so the preview
    // paints before Y.js sync settles; ymeta.theme then takes over (bridged in `useDocument`).
    initialTheme: ref<DocTheme | null>(null),
    // Plan features (server: `utils/entitlements.ts`). `false` = the plan has
    // no custom CSS: it stays in the theme but is left out of preview and print
    // (the server PDF renderer drops it too). Defaults to true so nothing
    // flickers before /token answers.
    customCssAllowed: ref<boolean>(true),
    // Workspace brand kit: fonts every render declares, and the locked
    // workspace design (null = the document's own design).
    brandFonts: ref<BrandFont[]>([]),
    brandLockedTheme: ref<DocTheme | null>(null),
    // Share-link controls: this viewer may not download or print; the public
    // link has expired (shown on the "no access" page).
    noDownload: ref(false),
    shareExpired: ref(false),
    /** Team / Business plan covering the doc's workspace (header badge). */
    workspacePlan: ref<'team' | 'business' | null>(null),
    // Set when denied because the doc's workspace enforces single sign-on:
    // where to sign in through its IdP.
    ssoLoginUrl: ref<string | null>(null),
    // Title from the documents row; shown until the live `ymeta.title` exists.
    initialTitle: ref<string>(''),
    // Document context (description, audience, language): seeded from /token
    // like the theme, then bridged to ymeta.* in `useDocument`.
    initialDescription: ref<string>(''),
    initialAudience: ref<string>('casual'),
    initialLanguage: ref<string>('en'),
    // Template body with placeholders already substituted server-side. Null
    // for the `blank` template. Only seeded when ytext is empty.
    initialBody: ref<string | null>(null),
    // Template the doc started from (exported in the Markdown frontmatter).
    templateId: ref<string>('blank')
  }
}

export type DocAccessState = ReturnType<typeof createDocAccessState>

/** The first `/token` answer: the access tier, the gate fields and every seed. */
export function applyTokenAnswer(s: DocAccessState, data: TokenAnswer, userId: number | undefined): void {
  // The route answers `token: null` plus only the gate fields to a caller
  // who may not open the document; everything else exists only with a token.
  const granted = data.token === null ? null : data
  const denied = data.token === null ? data : null
  s.tokenData.value = { token: data.token ?? '', readOnly: data.readOnly }
  s.isReadOnly.value = data.readOnly
  s.requiresPassword.value = !!data.requiresPassword
  s.forbidden.value = !!data.forbidden
  s.canDelete.value = data.canDelete === true
  s.accessMode.value = data.accessMode
  s.workspaceId.value = data.workspaceId
  s.workspaceRole.value = data.workspaceRole
  s.initialTheme.value = data.theme ?? null
  s.customCssAllowed.value = data.planFeatures?.customCss !== false
  s.brandFonts.value = granted?.brandKit?.fonts ?? []
  s.brandLockedTheme.value = granted?.brandKit?.lockedTheme ?? null
  s.noDownload.value = granted?.noDownload === true
  s.shareExpired.value = denied?.shareExpired === true
  s.workspacePlan.value = data.workspacePlan ?? null
  s.ssoLoginUrl.value = denied?.ssoLoginUrl ?? null
  if (typeof granted?.title === 'string') s.initialTitle.value = granted.title
  if (typeof granted?.description === 'string') s.initialDescription.value = granted.description
  if (typeof granted?.audience === 'string') s.initialAudience.value = granted.audience
  if (typeof granted?.language === 'string') s.initialLanguage.value = granted.language
  if (typeof granted?.templateId === 'string') s.templateId.value = granted.templateId
  s.initialBody.value = typeof data.initialBody === 'string' ? data.initialBody : null

  s.isOwner.value = data.ownerId != null
    && typeof userId === 'number'
    && data.ownerId === userId
  s.hasOwner.value = data.ownerId != null
}

/**
 * A token refetch that issued no token: when the access ended (forbidden or
 * password-gated now), flip to the gate a fresh page load would show.
 */
export function applyAccessEnded(s: DocAccessState, data: TokenAnswer & { token: null }): void {
  if (!data.forbidden && !data.requiresPassword) return
  s.shareExpired.value = data.shareExpired === true
  s.ssoLoginUrl.value = data.ssoLoginUrl ?? null
  s.tokenData.value = { token: '', readOnly: true }
  s.isReadOnly.value = true
  if (data.forbidden) s.forbidden.value = true
  if (data.requiresPassword) s.requiresPassword.value = true
}

/** `/meta` read with the unlock JWT: re-seeds what a gated `/token` answer left out. */
export function applyUnlockedMeta(s: DocAccessState, data: MetaAnswer): void {
  // A response without the document (still gated) carries none of the metadata.
  const meta = data.granted ? data : null
  s.initialTheme.value = meta?.theme ?? null
  s.brandFonts.value = meta?.brandKit?.fonts ?? []
  s.brandLockedTheme.value = meta?.brandKit?.lockedTheme ?? null
  s.noDownload.value = meta?.noDownload === true
  if (typeof meta?.title === 'string') s.initialTitle.value = meta.title
  if (typeof meta?.description === 'string') s.initialDescription.value = meta.description
  if (typeof meta?.audience === 'string') s.initialAudience.value = meta.audience
  if (typeof meta?.language === 'string') s.initialLanguage.value = meta.language
  s.initialBody.value = typeof meta?.initialBody === 'string' ? meta.initialBody : null
}
