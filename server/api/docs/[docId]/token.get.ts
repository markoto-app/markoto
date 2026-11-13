import { docBrandForClient } from '../../../utils/brandKit/docBrand'
import jwt from 'jsonwebtoken'
import { ssoLoginUrlForMember } from '../../../utils/sso/required'
import { canDownload, decideDocDelete, decideTokenAccess, isVisitor } from '../../../../shared/utils/documents/docPermissions'
import { docJwtLifetimeSeconds } from '../../../utils/documents/docJwt'
import { recordDocumentOpen } from '../../../repos/documentViews'
import { anonCreatorKeyMatches, readAnonCreatorKey } from '../../../utils/auth/anonCreator'
import type { SessionJwtPayload } from '../../../../shared/contracts/jwt'
import { renderTemplate } from '../../../utils/documents/templateRenderer'
import { planHasFeature, resolveDocPlanFor } from '../../../utils/billing/entitlements'
import { pooledPlansFor } from '../../../utils/billing/workspaceBilling'
import { docTokenQuery } from '~~/shared/api/docs'
import { MINUTE_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

// The Y.js connection token of a document, for everyone who opens its link
// (also anonymous visitors). A missing document is 404 rather than an
// anonymous token: no "token shape" disclosure, no wasted sync-server connect,
// a clear error for the client. A caller who may not open it gets `token: null`
// and only what the editor needs to draw the gate, never a 403.
export default defineApiHandler({
  access: allow.doc('lookup', {
    anonymous: true,
    reason: 'decideTokenAccess on the policy\'s DocState (share expiry, SSO owner suspension applied): a usable JWT only on allow, otherwise token: null and the gate fields'
  }),
  query: docTokenQuery,
  // Before the lookup: every request counts, so probing for document ids is throttled too.
  rateLimit: { namespace: 'token', max: 30, windowMs: MINUTE_MS, key: 'ip', phase: 'before-access' },
  handler: async ({ event, user, docId, doc: row, state: doc, actor, query, docAccess }) => {
    const env = useEnv()
    if (!env.auth.jwtSecret) {
      throw apiError('internal')
    }

    const decision = decideTokenAccess(doc, actor)

    // Denied (private / password-gated, caller not entitled): return only
    // what the editor needs to draw the gate. No title-derived template
    // body, description, owner, workspace or theme, a
    // leaked link to a private doc must not leak its metadata.
    if (decision.outcome === 'forbidden' || decision.outcome === 'password-required') {
      // A member of a workspace that enforces single sign-on gets the
      // link to sign in through it; everyone else learns nothing more.
      const ssoLoginUrl = decision.outcome === 'forbidden' && row.workspaceId && user
        ? await ssoLoginUrlForMember(row.workspaceId, user.id, `/d/${docId}`)
        : null
      return {
        ssoLoginUrl,
        // Share-link controls: the public link ended, the page says
        // so instead of "no access". Nothing else about the doc is revealed.
        shareExpired: doc.shareExpired === true,
        // `token` tells the two answers apart: null here, the document JWT when granted.
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
    // owner's: server/utils/billing/entitlements.ts). The editor uses them to
    // leave paused features out of the preview and the browser print, and
    // to show the plan notice in the theme panel. The renderer and the
    // write paths check the plan themselves; this is UI hydration only.
    const docPlan = await resolveDocPlanFor({ ownerId: row.ownerId, workspaceId: row.workspaceId })

    // workspaceId + workspaceRole leak to the client so the editor UI can
    // decide which File-menu items to render without a second round-trip.
    // They don't widen access, the client already knows it has the doc
    // open, and the server re-checks every mutation anyway.
    const responseBase = {
      readOnly: decision.readOnly,
      accessMode: row.accessMode,
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
      // A guest is not a member: no workspace role for the UI (no
      // knowledge panel, no sharing); `guest` says why they may open it.
      workspaceRole: row.isGuest ? null : row.workspaceRole,
      guest: row.isGuest,
      theme: row.theme,
      // Title as stored on the row (set by the new-document dialog). The
      // editor shows it until the live Y.js title (`ymeta.title`) exists,
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
      // `blank` template: the document then stays empty. Always
      // shipped: the client only inserts when ytext is empty, so
      // re-fetching the token on a doc that already has content is
      // harmless.
      initialBody: renderTemplate(row.templateId, {
        title: row.title,
        description: row.description,
        language: row.language
      }),
      templateId: row.templateId,
      planFeatures: { customCss: planHasFeature(docPlan, 'customCss') },
      // Workspace brand kit: the fonts every render declares and,
      // while the workspace design is locked, that design (the editor
      // renders with it, keeping only the document's cover text).
      // The token is granted at this point, which includes viewing.
      brandKit: await docBrandForClient(docAccess.allows('view') ? docAccess : null),
      // Share-link controls: this viewer may not download or print.
      noDownload: !canDownload(doc, actor, row.shareNoDownload),
      // The Team / Business plan covering the doc's workspace (header badge).
      workspacePlan: row.workspaceId ? (await pooledPlansFor([row.workspaceId])).get(row.workspaceId) ?? null : null,
      // Whether DELETE /api/docs/:id would succeed for this caller, the
      // File menu shows "Delete" only then. For an anonymous doc that's
      // only the creating browser (creator-key cookie).
      canDelete: decideDocDelete(doc, {
        ...actor,
        isAnonCreator: anonCreatorKeyMatches(readAnonCreatorKey(event), row.anonCreatorKeyHash)
      }).outcome === 'allow'
    }

    const payload = {
      docId,
      userId: user?.id || 'anonymous',
      // Carried so the sync-server can attribute edits reliably without
      // guessing from awareness (a cursor move by User A can otherwise
      // steal attribution from a real edit by User B). Anonymous users
      // end up with null here; the sync-server falls back to awareness.
      userName: user?.name ?? null,
      readOnly: decision.readOnly
    } satisfies SessionJwtPayload
    // ≤ 2 h, and never past the share link's expiry.
    const token = jwt.sign(payload, env.auth.jwtSecret, { expiresIn: docJwtLifetimeSeconds(row.shareExpiresAt) })

    // View counts: an open by someone other than the owner and the
    // workspace members, on a plan with share controls. Aggregate per day,
    // best-effort: never fails the open. A token refresh (`?refresh=1`, the
    // editor's reconnect path) is not a new open.
    if (query.refresh !== '1' && isVisitor(doc, actor) && planHasFeature(docPlan, 'shareControls') && docAccess.allows('view')) {
      void recordDocumentOpen(docAccess).catch(() => {})
    }

    return { token, requiresPassword: false as const, forbidden: false as const, ...responseBase }
  }
})
