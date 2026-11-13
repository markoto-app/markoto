/** An ISO timestamp as a short local date + time ("12 Nov 2026, 14:05"); '' for none, the input when unparseable. */
export function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}
