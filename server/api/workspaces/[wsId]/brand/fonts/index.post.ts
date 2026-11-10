import { inspectFont } from '../../../../../utils/brandKit/fontInspect'
import { requireBrandKitAdmin } from '../../../../../utils/brandKit/access'
import { newBrandAssetId, readBrandUpload } from '../../../../../utils/brandKit/upload'
import { brandAssetKey, deleteBrandObjects, putBrandObject } from '../../../../../utils/brandKit/storage'
import { countBrandAssets, deleteBrandAsset, insertBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { DuplicateError } from '../../../../../repos/errors'
import { AUDIT_WORKSPACE_BRAND_ASSET_ADDED } from '../../../../../legal/auditActions'
import { BRAND_FONT_FAMILY_RE, BRAND_FONT_MAX_BYTES, BRAND_FONTS_PER_WORKSPACE } from '~~/shared/config/brandKit'
import { selfHostedFont } from '~~/shared/utils/themeFonts'

// POST /api/workspaces/:wsId/brand/fonts — upload one font file (WP10).
// Multipart: `file` (WOFF2 / WOFF / TTF), `licence` = "true" (the admin
// confirms the workspace may embed it in documents and PDFs), optional
// `family` / `weight` / `style` overriding what the file says. Static
// TrueType outlines only — variable, CFF and no-embedding fonts are
// refused (422 `brand/font-refused` + `reason`).

const REFUSAL_MESSAGES: Record<string, string> = {
  'not-a-font': 'This is not a font file. Upload a WOFF2, WOFF or TTF file.',
  'collection': 'This file holds several fonts (a font collection). Upload each style as its own file.',
  'variable': 'Variable fonts print badly in PDFs. Upload the static cuts (one file per weight and style) instead.',
  'cff': 'Fonts with PostScript (CFF) outlines print badly in PDFs. Upload the TrueType (TTF / WOFF2) version instead.',
  'no-embedding': 'This font\'s licence does not allow embedding it in documents.',
  'damaged': 'This font file is damaged or incomplete.'
}

export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireBrandKitAdmin(event)
  const { bytes, form } = await readBrandUpload(event, BRAND_FONT_MAX_BYTES)
  if (form.get('licence') !== 'true') {
    throw createError({ statusCode: 400, message: 'Confirm that your licence allows embedding this font in documents.', data: { code: 'brand/licence-required' } })
  }
  const inspected = inspectFont(bytes)
  if (!inspected.ok) {
    throw createError({ statusCode: 422, message: REFUSAL_MESSAGES[inspected.reason], data: { code: 'brand/font-refused', reason: inspected.reason, messageKey: `brandKit.fontRefused.${inspected.reason}` } })
  }

  const rawFamily = form.get('family')
  const family = (typeof rawFamily === 'string' && rawFamily.trim() ? rawFamily : inspected.family).replace(/\s+/g, ' ').trim()
  if (!BRAND_FONT_FAMILY_RE.test(family)) {
    throw createError({ statusCode: 400, message: 'The font name may use letters, digits and spaces (up to 40).', data: { code: 'brand/invalid-family', field: 'family' } })
  }
  if (selfHostedFont(family)) {
    throw createError({ statusCode: 409, message: `"${family}" is one of markoto's built-in fonts. Give your font another name.`, data: { code: 'brand/family-built-in', field: 'family' } })
  }
  const rawWeight = form.get('weight')
  const weight = typeof rawWeight === 'string' && rawWeight !== '' ? Number(rawWeight) : inspected.weight
  if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) {
    throw createError({ statusCode: 400, message: 'Weight is 100–900 in steps of 100.', data: { code: 'brand/invalid-weight', field: 'weight' } })
  }
  const rawStyle = form.get('style')
  const style = rawStyle === 'italic' || rawStyle === 'normal' ? rawStyle : (inspected.italic ? 'italic' : 'normal')

  if (await countBrandAssets(wsId, 'font') >= BRAND_FONTS_PER_WORKSPACE) {
    throw createError({ statusCode: 409, message: `A workspace can have up to ${BRAND_FONTS_PER_WORKSPACE} font files.`, data: { code: 'brand/too-many-fonts', limit: BRAND_FONTS_PER_WORKSPACE } })
  }

  const id = newBrandAssetId()
  const key = brandAssetKey(wsId, id, inspected.format)
  // Row first (the unique face index refuses a duplicate before anything
  // is stored), then the object; a failed upload takes the row back.
  try {
    await insertBrandAsset({ id, workspaceId: wsId, kind: 'font', format: inspected.format, name: family, weight, style, sizeBytes: bytes.byteLength, s3Key: key, uploadedBy: userId, licenceConfirmedAt: new Date() })
  } catch (e) {
    if (e instanceof DuplicateError) {
      throw createError({ statusCode: 409, message: `The workspace already has ${family} ${weight}${style === 'italic' ? ' italic' : ''}. Delete it first to replace it.`, data: { code: 'brand/font-exists' } })
    }
    throw e
  }
  try {
    await putBrandObject(key, bytes, inspected.format)
  } catch (e) {
    await deleteBrandAsset(wsId, id)
    await deleteBrandObjects([key])
    throw e
  }
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BRAND_ASSET_ADDED,
    after: { kind: 'font', family, weight, style, format: inspected.format },
    metadata: { assetId: id, sizeBytes: bytes.byteLength }
  })
  setResponseStatus(event, 201)
  return { id, file: `${id}.${inspected.format}`, kind: 'font', family, weight, style, format: inspected.format, sizeBytes: bytes.byteLength }
})
