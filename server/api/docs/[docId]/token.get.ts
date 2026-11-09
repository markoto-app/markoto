import jwt from 'jsonwebtoken'
import { ssoLoginUrlForMember } from '../../../utils/sso/required'
import { getDocWithActorRole } from '../../../repos/documents'
import { docStateOf, decideDocDelete, decideTokenAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { anonCreatorKeyMatches, readAnonCreatorKey } from '../../../utils/anonCreator'
import type { SessionJwtPayload } from '../../../../shared/contracts/jwt'
import { renderTemplate } from '../../../utils/templateRenderer'
import { planHasFeature, resolveDocPlanFor } from '../../../utils/entitlements'
import { pooledPlansFor } from '../../../utils/workspaceBilling'

export default defineEventHandler(async (event) => {
  // Rate limit: 30 token requests per IP per minute
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('token', ip, 30, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })
  }

  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)
  const config = useRuntimeConfig()

  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    // 404 rather than an anonymous token for a nonexistent doc: (a) prevents
    // "token shape" info-disclosure; (b) avoids a wasted sync-server connect
    // attempt; (c) gives the client a clear error to display.
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole
  }

  const decision = decideTokenAccess(doc, actor)

  // Denied (private / password-gated, caller not entitled): return only
  // what the editor needs to draw the gate. No title-derived template
  // body, description, owner, workspace or theme — a
  // leaked link to a private doc must not leak its metadata.
  if (decision.outcome === 'forbidden' || decision.outcome === 'password-required') {
    // A member of a workspace that enforces single sign-on (WP14) gets the
    // link to sign in through it; everyone else learns nothing more.
    const ssoLoginUrl = decision.outcome === 'forbidden' && row.workspaceId && session?.user?.id
      ? await ssoLoginUrlForMember(row.workspaceId, session.user.id, `/d/${docId}`)
      : null
    return {
      ssoLoginUrl,
      token: null,
      requiresPassword: decision.outcome === 'password-required',
      forbidden: decision.outcome === 'forbidden',
      readOnly: true,
      accessMode: row.accessMode,
      ownerId: null,
      workspaceId: null,
      workspaceRole: null,
      theme: null,
      initialBody: null,
      canDelete: false,
      planFeatures: null,
      workspacePlan: null
    }
  }

  // Plan features of THIS document (its workspace's plan, else its
  // owner's — server/utils/entitlements.ts). The editor uses them to
  // leave paused features out of the preview and the browser print, and
  // to show the plan notice in the theme panel. The renderer and the
  // write paths check the plan themselves; this is UI hydration only.
  const docPlan = await resolveDocPlanFor({ ownerId: row.ownerId, workspaceId: row.workspaceId })

  // workspaceId + workspaceRole leak to the client so the editor UI can
  // decide which File-menu items to render without a second round-trip.
  // They don't widen access — the client already knows it has the doc
  // open, and the server re-checks every mutation anyway.
  const responseBase = {
    readOnly: decision.readOnly,
    accessMode: row.accessMode,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    workspaceRole: row.workspaceRole,
    theme: row.theme,
    // Title as stored on the row (set by the new-document dialog). The
    // editor shows it until the live Y.js title (`ymeta.title`) exists —
    // a freshly created doc has a DB title but no ymeta title yet.
    title: row.title,
    // Document context fields. The editor uses these to seed the
    // Document tab + the AI prompt context surfaces; the server-side
    // AI prompt path reads them straight from the documents row, so
    // exposing them here is for UI hydration only.
    description: row.description,
    audience: row.audience,
    language: row.language,
    // Rendered template body (with {{title}} / {{description}}
    // substituted, locale-matched on doc.language). Null for the
    // `blank` template — the document then stays empty. Always
    // shipped — the client only inserts when ytext is empty, so
    // re-fetching the token on a doc that already has content is
    // harmless.
    initialBody: renderTemplate(row.templateId, {
      title: row.title,
      description: row.description,
      language: row.language
    }),
    templateId: row.templateId,
    planFeatures: { customCss: planHasFeature(docPlan, 'customCss') },
    // The Team / Business plan covering the doc's workspace (header badge).
    workspacePlan: row.workspaceId ? (await pooledPlansFor([row.workspaceId])).get(row.workspaceId) ?? null : null,
    // Whether DELETE /api/docs/:id would succeed for this caller — the
    // File menu shows "Delete" only then. For an anonymous doc that's
    // only the creating browser (creator-key cookie).
    canDelete: decideDocDelete(doc, {
      ...actor,
      isAnonCreator: anonCreatorKeyMatches(readAnonCreatorKey(event), row.anonCreatorKeyHash)
    }).outcome === 'allow'
  }

  const payload = {
    docId,
    userId: session?.user?.id || 'anonymous',
    // Carried so the sync-server can attribute edits reliably without
    // guessing from awareness (a cursor move by User A can otherwise
    // steal attribution from a real edit by User B). Anonymous users
    // end up with null here; the sync-server falls back to awareness.
    userName: session?.user?.name ?? null,
    readOnly: decision.readOnly
  } satisfies SessionJwtPayload
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '2h' })

  return { token, requiresPassword: false, forbidden: false, ...responseBase }
})
