import { renderMarkdown } from '~/utils/markdown/renderMarkdown'

/**
 * Reactive wrapper around `renderMarkdown` (`app/utils/markdown/renderMarkdown.ts`):
 * `rendered` holds sanitized HTML and follows the source. The pipeline lives
 * outside Vue so the PDF print path shares the same security boundary.
 */
export function useMarkdownPreview(source: Ref<string>) {
  const rendered = ref('')

  if (import.meta.client) {
    const update = async (val: string) => {
      rendered.value = await renderMarkdown(val)
    }
    // A failed render keeps the last good HTML on screen.
    const refresh = (val: string) => {
      update(val).catch((err: unknown) => console.warn('[preview] markdown render failed', err))
    }
    refresh(source.value)
    watch(source, refresh)
  }

  return { rendered }
}
