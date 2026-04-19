import { renderMarkdown } from '~/utils/renderMarkdown'

/**
 * Reactive wrapper around the shared `renderMarkdown` pipeline. Returns a
 * `rendered` ref of sanitized HTML that updates whenever the source changes.
 * The actual markdown-it + DOMPurify singleton lives in
 * `app/utils/renderMarkdown.ts` so the PDF print path can use the same
 * security boundary without going through Vue reactivity.
 */
export function useMarkdownPreview(source: Ref<string>) {
  const rendered = ref('')

  if (import.meta.client) {
    const update = async (val: string) => {
      rendered.value = await renderMarkdown(val)
    }
    update(source.value)
    watch(source, (val) => { update(val) })
  }

  return { rendered }
}
