import type { EditorView } from '@codemirror/view'
import { nanoid } from 'nanoid'
import { errorStatus, resolveErrorMessage } from '~/utils/api/errors'

interface UploadResult {
  fileId: string
  url: string
}

export function useImageUpload(docId: string) {
  const uploading = ref(false)
  const error = ref<string | null>(null)
  // `$i18n` rather than `useI18n()`: the composable is also used outside a
  // component setup context.
  const i18n = useNuxtApp().$i18n

  async function upload(file: File): Promise<UploadResult | null> {
    uploading.value = true
    error.value = null

    try {
      const { uploadUrl, fileId, key } = await apiFetch('/api/upload/request', {
        method: 'post',
        body: {
          docId,
          filename: file.name,
          contentType: file.type,
          size: file.size
        }
      })

      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      })

      if (!putResponse.ok) {
        throw new Error(`S3 upload failed: ${putResponse.status}`)
      }

      await apiFetch('/api/upload/confirm', {
        method: 'post',
        body: { key }
      })

      const url = `/api/files/${docId}/${fileId}`
      return { fileId, url }
    } catch (e) {
      // The refusal's text in the reader's language, from its code (e.g. 409
      // `upload/storage-quota`), never the English server message.
      error.value = errorStatus(e) === 401 ? 'login_required' : resolveErrorMessage(e, i18n)
      return null
    } finally {
      uploading.value = false
    }
  }

  async function uploadAndInsert(file: File, view: EditorView) {
    const alt = file.name.replace(/\.[^.]+$/, '')
    // Unique per call so concurrent uploads don't collide on the post-upload `indexOf`.
    const placeholder = `![Uploading ${alt}...](upload-${nanoid()})`

    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, insert: placeholder }
    })

    const result = await upload(file)

    // Safe even if the user edited around it.
    const currentText = view.state.doc.toString()
    const placeholderPos = currentText.indexOf(placeholder)

    if (placeholderPos < 0) {
      // The user deleted the placeholder during upload.
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
