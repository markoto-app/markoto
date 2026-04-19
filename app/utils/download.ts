/**
 * Trigger a browser download for a Blob or string content.
 */
export function downloadFile(content: Blob | string, filename: string, mimeType?: string) {
  const blob = typeof content === 'string'
    ? new Blob([content], { type: mimeType || 'text/plain' })
    : content

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Download markdown content as a .md file.
 */
export function downloadMarkdown(content: string, title: string) {
  const filename = `${sanitizeFilename(title)}.md`
  downloadFile(content, filename, 'text/markdown')
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'document'
}
