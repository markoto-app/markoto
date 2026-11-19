import type { DeepReadonly } from 'vue'
import type * as Y from 'yjs'
import type { BrandFont } from '~~/shared/config/brandKit'
import type { DocTheme } from '~~/shared/types/theme'
import type { CitationInputs } from '~/utils/markdown/citationResolve'

/**
 * The editor's ways out of the document: browser print (the hidden-iframe
 * paged.js flow, also on Cmd/Ctrl+P), the server-rendered PDF, and the
 * Markdown download with markoto frontmatter. A view-only share link
 * allows none of them for this viewer (the server refuses the PDF too).
 */
export function useEditorExports(opts: {
  docId: string
  ytext: Y.Text
  /** What the preview renders (brand lock and plan applied). */
  renderTheme: Ref<DocTheme>
  /** The document's own theme (exported as is). */
  theme: Readonly<Ref<DeepReadonly<DocTheme>>>
  textContent: Ref<string>
  title: Ref<string>
  description: Ref<string>
  audience: Ref<string>
  language: Ref<string>
  templateId: Readonly<Ref<string>>
  noDownload: Readonly<Ref<boolean>>
  brandFonts: Readonly<Ref<readonly BrandFont[]>>
  /** The document's bibliography and citation style. */
  citations: Readonly<Ref<CitationInputs>>
  getDocJwt: () => Promise<string | null>
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { showError } = useErrorHandler()
  // Drives the dropdown loader spinner.
  const exporting = ref(false)

  function refuseDownload(): boolean {
    if (!opts.noDownload.value) return false
    toast.add({ title: t('share.controls.downloadDisabled'), icon: 'i-lucide-ban', color: 'neutral' })
    return true
  }

  async function exportPdf() {
    if (refuseDownload()) return
    exporting.value = true
    try {
      // Read fresh from ytext; the shallowRef may be stale after HMR.
      await printDocumentAsPdf({
        source: opts.ytext.toString(),
        theme: opts.renderTheme.value,
        title: opts.title.value,
        docId: opts.docId,
        language: opts.language.value,
        getDocJwt: opts.getDocJwt,
        brandFonts: opts.brandFonts.value,
        citations: opts.citations.value
      })
    } catch (e) {
      showError('error.pdfExportFailedTitle', e)
    } finally {
      exporting.value = false
    }
  }

  // The file carries theme, document properties and the bibliography as YAML
  // frontmatter (shared/utils/markdown/markdownFrontmatter.ts) so importing restores them.
  function exportProperties() {
    return {
      title: opts.title.value,
      description: opts.description.value,
      audience: opts.audience.value,
      language: opts.language.value,
      templateId: opts.templateId.value,
      // Plain copy: the theme ref is a readonly proxy.
      theme: structuredClone(toRaw(opts.theme.value)) as DocTheme,
      references: opts.citations.value.items,
      citationStyle: opts.citations.value.style
    }
  }

  async function exportMarkdown() {
    if (refuseDownload()) return
    const { buildMarkdownExport } = await import('~~/shared/utils/markdown/markdownFrontmatter')
    downloadMarkdown(buildMarkdownExport(opts.textContent.value, exportProperties()), opts.title.value)
  }

  /**
   * Markdown with the open suggestions in CriticMarkup ({++ ++}, {-- --},
   * {~~ ~> ~~}). Same front matter as the plain export; the plain export,
   * the preview, the PDF and published pages have the accepted text only.
   */
  async function exportMarkdownWithSuggestions(suggestions: ReadonlyArray<{ from: number, to: number, text: string }>) {
    if (refuseDownload()) return
    const [{ buildMarkdownExport }, { toCriticMarkup }] = await Promise.all([
      import('~~/shared/utils/markdown/markdownFrontmatter'),
      import('~~/shared/utils/suggestions/criticMarkup')
    ])
    const content = buildMarkdownExport(toCriticMarkup(opts.textContent.value, suggestions), exportProperties())
    downloadMarkdown(content, `${opts.title.value} (suggestions)`)
  }

  // Server-rendered PDF from the Playwright renderer, served by /api/docs/:id/pdf
  // as a 302 to a presigned S3 URL. Unlike `exportPdf()` (browser print dialog +
  // paged.js), the bytes are produced server-side, so the recipient needn't have
  // the editor open.
  //
  // Opens a new tab with `?inline=1` (Content-Disposition inline, so the PDF
  // viewer renders it). A synthetic anchor click is used instead of
  // `window.open()`: Nuxt UI's dropdown defers `onSelect` past the user-gesture
  // window and Chrome's popup blocker swallows `window.open()`. The same pattern
  // `downloadFile()` uses for the markdown export.
  function openServerPdf() {
    if (refuseDownload()) return
    const a = document.createElement('a')
    a.href = `/api/docs/${opts.docId}/pdf?inline=1`
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  usePrintShortcut(exportPdf)

  return { exporting, exportPdf, exportMarkdown, exportMarkdownWithSuggestions, openServerPdf }
}

/**
 * Hijack Cmd/Ctrl+P so File → Print runs our hidden-iframe PDF flow; the
 * browser default would print the whole app chrome. Intercepted at document
 * level with `capture: true` to win against any focused element (CodeMirror,
 * slideovers, modals). `useEventListener` rather than `onKeyStroke`: capture
 * phase is required and `onKeyStroke` doesn't expose `capture`.
 */
function usePrintShortcut(print: () => Promise<void>): void {
  // Mac detection prefers `navigator.userAgentData.platform` and falls back to
  // `navigator.platform` (browsers without userAgentData, e.g. Safari < 17).
  const isMacPlatform = (): boolean => {
    const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
    if (uad?.platform) return /mac/i.test(uad.platform)
    return /Mac|iPhone|iPad/.test(navigator.platform)
  }
  useEventListener(document, 'keydown', (e: KeyboardEvent) => {
    const isPrint = (isMacPlatform() ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey
      && (e.key === 'p' || e.key === 'P')
    if (!isPrint) return
    e.preventDefault()
    void print()
  }, { capture: true })
}
