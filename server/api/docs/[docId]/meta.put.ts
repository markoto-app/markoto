import { getDoc, updateDocMeta, type MetaUpdate } from '../../../repos/documents'
import type { DocAccess } from '../../../repos/proofs'
import { appendAuditEvent } from '../../../repos/audit'
import { assertPlanFeature, resolveDocPlan } from '../../../utils/billing/entitlements'
import { ownCustomCss } from '~~/shared/utils/theme/themePresets'
import { assertNotModerationRestricted } from '../../../utils/privacy/moderationRestriction'
import { notifySyncReauthDocument } from '../../../utils/documents/syncNotify'
import { accessModeTightened } from '../../../../shared/utils/documents/docPermissions'
import { updateDocMetaBody } from '~~/shared/api/docs'

// PUT /api/docs/:docId/meta. Meta changes split by kind: accessMode is a
// sharing/ownership change (owner + workspace admin only), everything else is
// an edit (owner + admin + editor). Viewers cannot change anything. A request
// carrying accessMode without manage rights is refused whole, no field lands.
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  body: updateDocMetaBody,
  handler: async ({ event, docId, doc, docAccess, body }) => {
    if (body.accessMode !== undefined && !docAccess.allows('manage')) {
      throw apiError('docs/manage-forbidden')
    }

    const updates = metaUpdatesOf(body)
    // Custom CSS needs the doc id (only this doc's uploads may be
    // referenced) and the request origin, so it is checked here rather
    // than in the schema.
    assertValidThemeCustomCss(updates.theme, docId, event)
    await assertCustomCssAllowedByPlan(updates.theme, docAccess)
    // Same for theme images: the schema checks the shape, but only this
    // document's uploads (or a bundled asset) may be referenced.
    if (updates.theme && themeImagesForDoc(updates.theme, docId).dropped.length > 0) {
      throw apiError('theme/image-not-in-doc')
    }

    // Snapshot the prior access mode BEFORE the write so we can record
    // the before/after for the audit row. Only fetched when accessMode
    // is changing: title / description / theme / etc. are user-facing
    // edits captured by the activity log, not security events.
    let beforeAccessMode: string | null = null
    if (updates.accessMode !== undefined) {
      const snap = await getDoc(docAccess)
      if (updates.accessMode !== 'private') assertNotModerationRestricted(snap)
      beforeAccessMode = snap?.accessMode ?? null
    }

    await updateDocMeta(docAccess, updates)

    if (updates.accessMode !== undefined && beforeAccessMode !== updates.accessMode) {
      await appendAuditEvent({
        by: docAccess,
        actorIp: getClientIp(event),
        scope: 'doc',
        scopeId: docId,
        action: 'doc.access_mode_changed',
        workspaceId: doc.workspaceId,
        before: { accessMode: beforeAccessMode },
        after: { accessMode: updates.accessMode }
      })
      // Open editors keep their token's access until they re-authenticate.
      if (accessModeTightened(beforeAccessMode, updates.accessMode)) notifySyncReauthDocument(docId)
    }

    return { success: true }
  }
})

/** The fields to write: one left out (or, for the counts, not a number) keeps its value. */
function metaUpdatesOf(body: MetaUpdate): MetaUpdate {
  const updates: MetaUpdate = {}
  if (body.title !== undefined) updates.title = body.title
  if (body.accessMode !== undefined) updates.accessMode = body.accessMode
  if (body.wordCount !== undefined) updates.wordCount = body.wordCount
  if (body.sizeBytes !== undefined) updates.sizeBytes = body.sizeBytes
  if (body.theme !== undefined) updates.theme = body.theme
  if (body.description !== undefined) updates.description = body.description
  if (body.audience !== undefined) updates.audience = body.audience
  if (body.language !== undefined) updates.language = body.language
  if (body.templateId !== undefined) updates.templateId = body.templateId
  return updates
}

/**
 * Plan gate for custom CSS: refuse a theme write that sets NEW custom CSS
 * on a document whose plan doesn't include it (409
 * `plan/feature-unavailable`). CSS identical to what is already stored
 * passes, so the editor can keep saving other theme changes of a doc
 * whose CSS is paused. Y.js `ymeta` writes bypass this endpoint, the
 * renderers drop the CSS for such documents (render-bootstrap +
 * `EditorLayout`'s `renderTheme`), which is the authoritative check.
 */
async function assertCustomCssAllowedByPlan(theme: MetaUpdate['theme'] | undefined, access: DocAccess<'view'>): Promise<void> {
  // Only the author's own CSS counts: a built-in preset's unchanged
  // template CSS (arXiv, IEEE, …) is part of the preset on every plan.
  const css = ownCustomCss(theme?.customCss)
  if (css === '') return
  const stored = (await getDoc(access))?.theme as { customCss?: string } | null | undefined
  if (ownCustomCss(stored?.customCss) === css) return
  assertPlanFeature(await resolveDocPlan(access.docId), 'customCss', 'Custom CSS is not included in this document\'s plan.')
}
