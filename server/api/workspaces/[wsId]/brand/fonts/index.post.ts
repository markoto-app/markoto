import { inspectFont } from '../../../../../utils/brandKit/fontInspect'
import { BRAND_KIT_PLAN_MESSAGE } from '../../../../../utils/brandKit/access'
import { newBrandAssetId, readBrandUpload } from '../../../../../utils/brandKit/upload'
import { brandAssetKey, deleteBrandObjects, putBrandObject } from '../../../../../utils/brandKit/storage'
import { countBrandAssets, insertBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { DuplicateError } from '../../../../../repos/errors'
import { AUDIT_WORKSPACE_BRAND_ASSET_ADDED } from '../../../../../legal/auditActions'
import { BRAND_FONT_FAMILY_RE, BRAND_FONT_MAX_BYTES, BRAND_FONTS_PER_WORKSPACE } from '~~/shared/config/brandKit'
import { selfHostedFont } from '~~/shared/utils/theme/themeFonts'
import { HOUR_MS } from '~~/shared/config/units'

// POST /api/workspaces/:wsId/brand/fonts — upload one font file.
// Multipart: `file` (WOFF2 / WOFF / TTF), `licence` = "true" (the admin
// confirms the workspace may embed it in documents and PDFs), optional
// `family` / `weight` / `style` overriding what the file says. Static
// TrueType outlines only — variable, CFF and no-embedding fonts are
// refused (422 `brand/font-refused` + `reason`).

export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  plan: { feature: 'brandKit', message: BRAND_KIT_PLAN_MESSAGE },
  body: 'multipart',
  rateLimit: { namespace: 'brand-upload', max: 60, windowMs: HOUR_MS, key: ctx => ctx.wsId, error: 'brand/rate-limited' },
  handler: async ({ event, user, wsId, workspaceAccess }) => {
    const { bytes, form } = await readBrandUpload(event, BRAND_FONT_MAX_BYTES)
    if (form.get('licence') !== 'true') throw apiError('brand/licence-required')
    const inspected = inspectFont(bytes)
    if (!inspected.ok) {
      throw apiError('brand/font-refused', { reason: inspected.reason, messageKey: `brandKit.fontRefused.${inspected.reason}` })
    }

    const { family, weight, style } = readFontFace(form, inspected)

    if (await countBrandAssets(workspaceAccess, 'font') >= BRAND_FONTS_PER_WORKSPACE) throw tooManyFonts()

    const id = newBrandAssetId()
    const key = brandAssetKey(wsId, id, inspected.format)
    // Object first, then the row: a render that sees the row (and so the
    // new brand fingerprint) can always load the file. The insert enforces
    // the cap and refuses a duplicate face; either way the object goes.
    await putBrandObject(key, bytes, inspected.format)
    let inserted: 'inserted' | 'limit'
    try {
      inserted = await insertBrandAsset(workspaceAccess, { id, kind: 'font', format: inspected.format, name: family, weight, style, sizeBytes: bytes.byteLength, s3Key: key, uploadedBy: user.id, licenceConfirmedAt: new Date() }, BRAND_FONTS_PER_WORKSPACE)
    } catch (e) {
      await deleteBrandObjects([key])
      if (e instanceof DuplicateError) {
        throw apiError('brand/font-exists')
      }
      throw e
    }
    if (inserted === 'limit') {
      await deleteBrandObjects([key])
      throw tooManyFonts()
    }
    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BRAND_ASSET_ADDED,
      after: { kind: 'font', family, weight, style, format: inspected.format },
      metadata: { assetId: id, sizeBytes: bytes.byteLength }
    })
    setResponseStatus(event, 201)
    return { id, file: `${id}.${inspected.format}`, kind: 'font', family, weight, style, format: inspected.format, sizeBytes: bytes.byteLength }
  }
})

function tooManyFonts() {
  return apiError('brand/too-many-fonts', { limit: BRAND_FONTS_PER_WORKSPACE })
}

/** Family, weight and style: the form's overrides, else what the file says. */
function readFontFace(form: FormData, inspected: { family: string, weight: number, italic: boolean }) {
  const rawFamily = form.get('family')
  const family = (typeof rawFamily === 'string' && rawFamily.trim() ? rawFamily : inspected.family).replace(/\s+/g, ' ').trim()
  if (!BRAND_FONT_FAMILY_RE.test(family)) {
    throw apiError('brand/invalid-family', { field: 'family' })
  }
  if (selfHostedFont(family)) {
    throw apiError('brand/family-built-in', { family, field: 'family' })
  }
  const rawWeight = form.get('weight')
  const weight = typeof rawWeight === 'string' && rawWeight !== '' ? Number(rawWeight) : inspected.weight
  if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) {
    throw apiError('brand/invalid-weight', { field: 'weight' })
  }
  const rawStyle = form.get('style')
  const style: 'normal' | 'italic' = rawStyle === 'italic' || rawStyle === 'normal' ? rawStyle : (inspected.italic ? 'italic' : 'normal')
  return { family, weight, style }
}
