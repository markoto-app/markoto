import { getDocWithActorRole } from '../../../../repos/documents'
import { getBrandAsset } from '../../../../repos/brandAssets'
import { docStateOf, decideFileAccess } from '../../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../../utils/docTokenVerify'
import { sendBrandAsset } from '../../../../utils/brandKit/storage'
import { BRAND_ASSET_FILE_RE } from '~~/shared/config/brandKit'

// GET /api/docs/:docId/brand/:file — a brand-kit font or logo of the
// document's workspace (WP10), as the document's renderers load it: the
// live preview + print iframes (opaque origin, the file-access token in
// `?token=`), the server render page (same token) and the editor itself
// (session). Same access decision as `/api/files`; the asset must belong
// to the document's workspace.
export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const match = BRAND_ASSET_FILE_RE.exec(requireRouteParam(event, 'file'))
  if (!match) throw createError({ statusCode: 400, message: 'Invalid file' })
  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) throw createError({ statusCode: 404, message: 'Document not found' })
  const decision = decideFileAccess(docStateOf(row), {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId, ['file-access'])
  })
  if (decision.outcome === 'deny') throw createError({ statusCode: 403, message: 'Access denied' })
  const asset = row.workspaceId ? await getBrandAsset(row.workspaceId, match[1]!) : null
  if (!asset || asset.format !== match[2]) throw createError({ statusCode: 404, message: 'Not found' })
  return sendBrandAsset(event, asset, { crossOrigin: true })
})
