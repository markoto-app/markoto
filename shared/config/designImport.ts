/**
 * "Create a design from a document" (theme panel): the user uploads a PDF
 * or Word file, markitdown extracts its styles (+ page pictures for PDF),
 * the user's own vision-capable chat model proposes a theme, we render a
 * sample in it and let the model correct it. See
 * server/utils/designImport/ and the section in server/utils/AGENTS.md.
 */

export const DESIGN_IMPORT_EXTENSIONS = ['pdf', 'docx'] as const
export type DesignImportExt = typeof DESIGN_IMPORT_EXTENSIONS[number]

export const DESIGN_IMPORT_MIME: Record<DesignImportExt, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

/** Largest upload. Design facts sit in the first pages; bigger files only cost time. */
export const DESIGN_IMPORT_MAX_BYTES = 20 * 1024 * 1024

/** PDF pages rendered for the model (the first ones: cover + a text page). */
export const DESIGN_IMPORT_MAX_PAGES = 4

/** Model calls per run: one proposal + up to two corrections after comparing renders. */
export const DESIGN_IMPORT_MAX_ROUNDS = 3

export function isDesignImportExt(ext: string): ext is DesignImportExt {
  return (DESIGN_IMPORT_EXTENSIONS as readonly string[]).includes(ext)
}

/** Progress phases shown in the dialog (`designImport.phase.<phase>`). */
export const DESIGN_IMPORT_PHASES = ['reading', 'designing', 'rendering', 'done', 'error'] as const
export type DesignImportPhase = typeof DESIGN_IMPORT_PHASES[number]

/** Stable error codes (`designImport.errors.<code>` in the dialog). */
export const DESIGN_IMPORT_ERROR_CODES = [
  'unreadable',
  'too-large',
  'no-vision',
  'provider-error',
  'budget',
  'invalid-design',
  'internal'
] as const
export type DesignImportErrorCode = typeof DESIGN_IMPORT_ERROR_CODES[number]
