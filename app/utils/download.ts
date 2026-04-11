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

/**
 * Download rendered HTML content as an .html file.
 */
export function downloadHtml(htmlContent: string, title: string) {
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    code { background: #f5f5f5; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }
    table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`

  const filename = `${sanitizeFilename(title)}.html`
  downloadFile(fullHtml, filename, 'text/html')
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'document'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
