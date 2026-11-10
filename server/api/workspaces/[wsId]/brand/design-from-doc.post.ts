import { requireBrandKitAdmin } from '../../../../utils/brandKit/access'
import { getDoc } from '../../../../repos/documents'
import { updateWorkspace } from '../../../../repos/workspaces'
import { flushSyncDocument } from '../../../../utils/syncNotify'
import { reconstructDocAtYjsId } from '../../../../utils/historyReplay'
import { resolveDocProperties } from '../../../../utils/docProperties'
import { defaultTheme as markotoTheme } from '~~/shared/utils/defaultTheme'
import { themeImagesForDoc } from '~~/shared/utils/themeImages'
import { adaptCustomCssToDoc } from '~~/shared/utils/customCss'
import { customCssAppOrigins } from '../../../../utils/themeCustomCss'

// POST /api/workspaces/:wsId/brand/design-from-doc — {docId} (WP10): make a
// workspace document's CURRENT design the workspace design (the default
// for new documents, and what the lock enforces). Admins, plan feature
// `brandKit`. The document's own uploads can't serve other documents, so
// they are left out — use the brand kit's logos for the shared design
// (`dropped` tells the UI which images went).
export default defineEventHandler(async (event) => {
  const { wsId } = await requireBrandKitAdmin(event)
  const body = await readBody<{ docId?: unknown }>(event)
  const docId = typeof body?.docId === 'string' ? body.docId : ''
  const doc = docId ? await getDoc(docId) : null
  if (!doc || doc.workspaceId !== wsId) throw createError({ statusCode: 404, message: 'Document not found in this workspace' })

  await flushSyncDocument(docId)
  const ydoc = await reconstructDocAtYjsId(docId, null)
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
  await updateWorkspace(wsId, { defaultTheme: design })
  return { defaultTheme: design, dropped }
})
