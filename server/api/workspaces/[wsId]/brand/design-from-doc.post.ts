import { BRAND_KIT_PLAN_MESSAGE } from '../../../../utils/brandKit/access'
import { getDoc } from '../../../../repos/documents'
import { updateWorkspace } from '../../../../repos/workspaces'
import { flushSyncDocument } from '../../../../utils/documents/syncNotify'
import { reconstructCurrentDoc } from '../../../../utils/documents/historyReplay'
import { resolveDocProperties } from '../../../../utils/documents/docProperties'
import { defaultTheme as markotoTheme } from '~~/shared/utils/theme/defaultTheme'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { adaptCustomCssToDoc } from '~~/shared/utils/theme/customCss'
import { customCssAppOrigins } from '../../../../utils/rendering/themeCustomCss'
import { designFromDocBody } from '~~/shared/api/brand'
import { proveWorkspaceDoc } from '../../../../utils/access/docProof'

// POST /api/workspaces/:wsId/brand/design-from-doc — {docId}: make a
// workspace document's CURRENT design the workspace design (the default
// for new documents, and what the lock enforces). Admins, plan feature
// `brandKit`. The document's own uploads can't serve other documents, so
// they are left out — use the brand kit's logos for the shared design
// (`dropped` tells the UI which images went).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  plan: { feature: 'brandKit', message: BRAND_KIT_PLAN_MESSAGE },
  body: designFromDocBody,
  invalidCode: 'brand/invalid',
  handler: async ({ event, wsId, body: { docId }, workspaceAccess }) => {
    // Only a document of this workspace: an id from elsewhere yields no proof.
    const docAccess = await proveWorkspaceDoc(workspaceAccess, docId)
    if (!docAccess?.allows('view')) throw apiError('template/doc-not-found')
    const doc = await getDoc(docAccess)
    if (!doc || doc.workspaceId !== wsId) throw apiError('template/doc-not-found')

    await flushSyncDocument(docId)
    const ydoc = await reconstructCurrentDoc(docAccess)
    let theme
    try {
      theme = resolveDocProperties(ydoc.getMap('meta'), doc).theme ?? markotoTheme
    } finally {
      ydoc.destroy()
    }
    // No document owns the workspace design: its images may only be brand
    // logos / bundled marks, its custom CSS may not point at uploads.
    const { theme: withoutUploads, dropped } = themeImagesForDoc(theme, '')
    const adapted = adaptCustomCssToDoc(withoutUploads.customCss, { docId: null, allowedOrigins: customCssAppOrigins(event) })
    const design = adapted.dropped.length === 0 ? withoutUploads : { ...withoutUploads, customCss: adapted.css }
    await updateWorkspace(workspaceAccess, { defaultTheme: design })
    return { defaultTheme: design, dropped }
  }
})
