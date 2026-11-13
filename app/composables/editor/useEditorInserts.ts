import type { EditorView } from '@codemirror/view'
import { insertTable } from '~/utils/editor/editorCommands'

/**
 * Inserts the menus and toolbars hand to the editor: the table-size dialog
 * (a centred dialog fits "I want a table" better than a popover far from the
 * menu trigger) and the image picker, which uses the same upload pipeline as
 * the toolbar's image button (`useImageUpload`).
 */
export function useEditorInserts(docId: string, view: () => EditorView | null, isReadOnly: Readonly<Ref<boolean>>) {
  const { t } = useI18n()
  const toast = useToast()

  const tableModalOpen = ref(false)
  function onTableModalSelect(payload: { rows: number, cols: number }) {
    const v = view()
    if (!v || isReadOnly.value) {
      tableModalOpen.value = false
      return
    }
    insertTable(v, payload.rows, payload.cols)
    tableModalOpen.value = false
  }

  const { uploadAndInsert: uploadImageAndInsert, error: imageUploadError } = useImageUpload(docId)
  watch(imageUploadError, (err) => {
    if (!err) return
    toast.add({
      title: err === 'login_required' ? t('auth.loginRequired') : t('image.uploadFailed'),
      description: err === 'login_required' ? t('image.loginToUpload') : err,
      color: 'error'
    })
  })
  const { open: openImagePicker, onChange: onMenuImagePicked } = useFileDialog({
    accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
    multiple: false,
    reset: true
  })
  // `uploadImageAndInsert` reports failures through `imageUploadError`; it does not reject.
  onMenuImagePicked((files) => {
    const file = files?.[0]
    const v = view()
    if (!file || !v) return
    void uploadImageAndInsert(file, v)
  })

  return { tableModalOpen, onTableModalSelect, openImagePicker }
}
