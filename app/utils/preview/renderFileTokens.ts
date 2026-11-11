import { brandAssetDocUrl, brandImageFile, ownUploadFileId } from '~~/shared/utils/theme/themeImages'

/**
 * File-access token handling for the server render page
 * (`app/pages/_internal/render/[docId].vue`).
 *
 * The renderer's Chromium has no session cookie, so images of private /
 * password-gated / workspace documents only load with the short-lived,
 * doc-scoped, read-only file token minted by the render bootstrap. The
 * token goes ONLY to URLs that are exactly one of this document's
 * confirmed uploads (`/api/files/<docId>/<fileId>` with `fileId` in the
 * bootstrap's list) — never to a link, another document's file, an
 * external URL that merely contains the path, or an upload id that
 * doesn't exist. Otherwise document content could make the page hand the
 * token to any URL it likes (and into the PDF's link annotations).
 */
export interface RenderFileAccess {
  docId: string
  /** `uploads.file_id` values of the document's confirmed uploads. */
  fileIds: ReadonlySet<string>
  /** The bootstrap's file-access JWT. */
  token: string
  /**
   * Brand-kit files (`<assetId>.<ext>`) of the document's workspace.
   * A theme's `/api/brand/<file>` image loads through
   * `/api/docs/<docId>/brand/<file>` with the token — only for these.
   */
  brandFiles?: ReadonlySet<string>
}

/** The URL a brand-kit file (font or logo) of this document loads from, with the token; null when unknown. */
export function renderBrandFileUrl(file: string, access: RenderFileAccess): string | null {
  if (!access.brandFiles?.has(file)) return null
  return `${brandAssetDocUrl(access.docId, file)}?token=${encodeURIComponent(access.token)}`
}

/** `url` with the file token appended when it is one of the document's own uploads; otherwise unchanged. */
export function withRenderFileToken(url: string, access: RenderFileAccess): string {
  const brand = brandImageFile(url)
  if (brand !== null) return renderBrandFileUrl(brand, access) ?? url
  const fileId = ownUploadFileId(url, access.docId)
  if (fileId === null || !access.fileIds.has(fileId)) return url
  return `${url}?token=${encodeURIComponent(access.token)}`
}

/**
 * Add the file token to every `<img src>` in `html` that points at one of
 * the document's own uploads (body images and the cover logo). Nothing
 * else is touched.
 */
export function attachRenderFileTokens(html: string, access: RenderFileAccess): string {
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  for (const img of template.content.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') ?? ''
    const next = withRenderFileToken(src, access)
    if (next !== src) {
      img.setAttribute('src', next)
      changed = true
    }
  }
  return changed ? template.innerHTML : html
}
