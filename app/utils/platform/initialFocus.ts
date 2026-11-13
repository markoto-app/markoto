/**
 * UModal `content` props that send the dialog's opening focus to one field.
 * Reka's focus scope otherwise lands on the first tabbable element, which is
 * the close button for dialogs with a header; for a dialog whose whole job is
 * one input (name, password, e-mail) that input is the primary action. This
 * replaces the HTML `autofocus` attribute, which only runs on page load and
 * is flagged by the accessibility lint.
 */
export function initialFocus(id: string): { onOpenAutoFocus: (event: Event) => void } {
  return {
    onOpenAutoFocus(event) {
      const el = document.getElementById(id)
      if (!el) return
      event.preventDefault()
      el.focus()
    }
  }
}
