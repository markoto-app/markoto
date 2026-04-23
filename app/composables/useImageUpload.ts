import type { EditorView } from '@codemirror/view'
import { nanoid } from 'nanoid'

interface UploadResult {
  fileId: string
  url: string
}

export function useImageUpload(docId: string) {
  const uploading = ref(false)
  const error = ref<string | null>(null)

  async function upload(file: File): Promise<UploadResult | null> {
    uploading.value = true
    error.value = null

    try {
      // 1. Request presigned URL
      const { uploadUrl, fileId, key } = await $fetch<{
        uploadUrl: string
        fileId: string
        key: string
      }>('/api/upload/request', {
        method: 'POST',
        body: {
          docId,
          filename: file.name,
          contentType: file.type,
          size: file.size
        }
      })

      // 2. PUT file directly to S3
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      })

      if (!putResponse.ok) {
        throw new Error(`S3 upload failed: ${putResponse.status}`)
      }

      // 3. Confirm upload
      await $fetch('/api/upload/confirm', {
        method: 'POST',
        body: { key }
      })

      const url = `/api/files/${docId}/${fileId}`
      return { fileId, url }
    } catch (e) {
      const err = e as { statusCode?: number, status?: number, data?: { statusCode?: number, message?: string }, message?: string }
      const statusCode = err.statusCode || err.data?.statusCode || err.status
      if (statusCode === 401) {
        error.value = 'login_required'
      } else {
        error.value = err.data?.message || err.message || 'Upload failed'
      }
      return null
    } finally {
      uploading.value = false
    }
  }

  async function uploadAndInsert(file: File, view: EditorView) {
    const alt = file.name.replace(/\.[^.]+$/, '')
    // Unique per-call so concurrent uploads don't collide on the
    // post-upload `indexOf` lookup. Any collision-free token works;
    // nanoid is already a project dep.
    const placeholder = `![Uploading ${alt}...](upload-${nanoid()})`

    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, insert: placeholder }
    })

    const result = await upload(file)

    // Find placeholder by its unique ID — safe even if user edited around it
    const currentText = view.state.doc.toString()
    const placeholderPos = currentText.indexOf(placeholder)

    if (placeholderPos < 0) {
      // Placeholder was deleted by user during upload — silently skip
      return
    }

    if (result) {
      const replacement = `![${alt}](${result.url})`
      view.dispatch({
        changes: {
          from: placeholderPos,
          to: placeholderPos + placeholder.length,
          insert: replacement
        }
      })
    } else {
      // Remove placeholder on failure
      view.dispatch({
        changes: {
          from: placeholderPos,
          to: placeholderPos + placeholder.length,
          insert: ''
        }
      })
    }
  }

  return {
    upload,
    uploading: readonly(uploading),
    error: readonly(error),
    uploadAndInsert
  }
}
