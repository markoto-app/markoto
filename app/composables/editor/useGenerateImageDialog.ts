/**
 * Open state of the editor's "Generate image with AI" dialog
 * (`AiGenerateImageModal`, mounted once by `EditorMenuBar`), shared so the
 * desktop Insert menu and the mobile Editor panel open the same dialog. A
 * plan without image generation gets the lock explanation instead, like
 * the other locked AI controls.
 */
export function useGenerateImageDialog() {
  const open = useState('generate-image-dialog-open', () => false)
  const { imageLocked } = useAiAvailability()
  const { explainLocked } = useAiLockedPrompt()

  function request() {
    if (imageLocked.value) {
      explainLocked('aiImage')
      return
    }
    open.value = true
  }

  return { open, request, imageLocked }
}
