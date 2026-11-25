import { DEFAULT_TEMPLATE_ID, getTemplate } from '~~/shared/templates'
import { LANGUAGE_PRESETS } from '~~/shared/languages'

// Whether this browser has created a document before. Anonymous visitors
// have no account to ask, so it is remembered in localStorage (reset by
// logout, which clears it, and absent in private windows: then the first-
// visit path runs once more, which is harmless).
const FIRST_DOC_KEY = 'markoto-created-first-doc'

export function browserHasCreatedDoc(): boolean {
  try {
    return globalThis.localStorage?.getItem(FIRST_DOC_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberBrowserCreatedDoc(): void {
  try {
    globalThis.localStorage?.setItem(FIRST_DOC_KEY, '1')
  } catch { /* storage blocked: the first-visit path runs again next time */ }
}

/**
 * The create request of a first document made without the dialog: the Demo
 * template in its own design, default details, in the language the visitor
 * is reading (the template has a version per UI language).
 */
export function firstDocumentBody(uiLocale: string): Record<string, unknown> {
  const design = getTemplate(DEFAULT_TEMPLATE_ID)?.design ?? 'markoto'
  const language = (LANGUAGE_PRESETS as readonly string[]).includes(uiLocale) ? uiLocale : 'en'
  return { templateId: DEFAULT_TEMPLATE_ID, themePreset: design, audience: 'casual', language }
}
