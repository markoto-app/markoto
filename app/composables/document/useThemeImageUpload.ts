import { brandAssetDocUrl, brandImageFile } from '~~/shared/utils/theme/themeImages'

/**
 * An image of the theme (cover logo, running-header image) uploaded through
 * the document's presigned-PUT image flow. `onUploaded` gets the image's
 * `/api/files/<doc>/<file>` URL; `uploading` drives the button spinner.
 */
export function useThemeImageUpload(docId: () => string, onUploaded: (url: string) => void) {
  const { extractError } = useErrorHandler()
  // `sr-only`, not `hidden`: the file input stays reachable by keyboard; the label shows its focus.
  const inputId = useId()
  const uploading = ref(false)
  const error = ref<string | null>(null)

  async function upload(file: File) {
    if (!file) return
    uploading.value = true
    error.value = null
    try {
      const { uploadUrl, fileId, key } = await apiFetch('/api/upload/request', {
        method: 'post',
        body: { docId: docId(), filename: file.name, contentType: file.type, size: file.size }
      })
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)
      await apiFetch('/api/upload/confirm', { method: 'post', body: { key } })
      onUploaded(`/api/files/${docId()}/${fileId}`)
    } catch (e) {
      error.value = extractError(e).message
    } finally {
      uploading.value = false
    }
  }

  function onFile(e: Event) {
    const input = e.target as HTMLInputElement
    const f = input.files?.[0]
    if (f) void upload(f)
    input.value = ''
  }

  return { inputId, uploading, error, onFile }
}

/** Where the theme panel previews a theme image (a brand URL loads through the document's brand route). */
export function themeImagePreviewSrc(url: string, docId: string): string {
  const file = brandImageFile(url)
  return file ? brandAssetDocUrl(docId, file) : url
}
