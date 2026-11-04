<script setup lang="ts">
import { renderTrustedMarkdown } from '~/utils/renderMarkdown'
import { KATEX_CSS_SRI, KATEX_CSS_URL } from '~~/shared/utils/katexAssets'
import { hljsTheme } from '~~/shared/utils/hljsAssets'

// Markdown source next to what markoto makes of it — for marketing
// content (`::sample` in content/marketing/**):
//
//   ::sample{kind="gfm"}
//   ---
//   source: |
//     | Left | Right |
//     |:-----|------:|
//     | a    |     b |
//   ---
//   ::
//
// The result is rendered on the server with the preview's markdown-it
// pipeline (`renderTrustedMarkdown`) and shipped as static HTML, so
// crawlers and no-JS readers see it. `kind` labels where the syntax comes
// from: plain CommonMark, GitHub Flavored Markdown, or a markoto extension
// (other editors may not render it).
const props = withDefaults(defineProps<{
  source: string
  kind?: 'commonmark' | 'gfm' | 'markoto'
}>(), { kind: 'commonmark' })

const { t } = useI18n()

function hashOf(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const source = computed(() => props.source.replace(/\n+$/, ''))
const { data: html } = await useAsyncData(
  `sample:${hashOf(source.value)}`,
  () => renderTrustedMarkdown(source.value),
  { default: () => '' }
)

// Stylesheets the result needs, self-hosted + SRI-locked like the preview's.
const CODE_THEME = hljsTheme('github-dark')
useHead(() => ({
  link: [
    ...(html.value.includes('class="katex')
      ? [{ key: 'katex-css', rel: 'stylesheet', href: KATEX_CSS_URL, integrity: KATEX_CSS_SRI, crossorigin: 'anonymous' as const }]
      : []),
    ...(html.value.includes('class="hljs')
      ? [{ key: 'hljs-css', rel: 'stylesheet', href: CODE_THEME.url, integrity: CODE_THEME.sri, crossorigin: 'anonymous' as const }]
      : [])
  ]
}))
</script>

<template>
  <figure
    class="mk-sample not-prose"
    data-testid="marketing-sample"
  >
    <div class="mk-sample__pane mk-sample__pane--source">
      <div class="mk-sample__label">
        <span>{{ t('marketing.sample.source') }}</span>
        <span
          class="mk-sample__kind"
          :class="`mk-sample__kind--${kind}`"
        >{{ t(`marketing.sample.kind.${kind}`) }}</span>
      </div>
      <pre class="mk-sample__code"><code>{{ source }}</code></pre>
    </div>
    <div class="mk-sample__pane mk-sample__pane--result">
      <div class="mk-sample__label">
        <span>{{ t('marketing.sample.result') }}</span>
      </div>
      <!-- Rendered from committed content only (see renderTrustedMarkdown). -->
      <div
        class="mk-sample__result"
        v-html="html"
      />
    </div>
  </figure>
</template>

<style scoped>
.mk-sample {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 20px 0 28px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg);
}
@media (min-width: 640px) {
  .mk-sample { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .mk-sample__pane--result { border-top: 0; border-left: 1px solid var(--ui-border); }
}
.mk-sample__pane { min-width: 0; display: flex; flex-direction: column; }
.mk-sample__pane--source { background: var(--ui-bg-elevated); }
.mk-sample__pane--result { border-top: 1px solid var(--ui-border); }
.mk-sample__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}
.mk-sample__kind {
  text-transform: none;
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.mk-sample__kind--markoto {
  color: var(--ui-text);
  border-color: var(--ui-border-accented);
}
/* `.mk-sample` in front: beats the article's `.prose pre/code` (and
   their `.dark` variants) from main.css. Ligatures off — JetBrains Mono
   would draw `==` or `~~` as one glyph, and the point here is the
   characters you type. */
.mk-sample .mk-sample__code {
  margin: 0;
  padding: 10px 14px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  font-variant-ligatures: none;
  color: var(--ui-text);
  background: transparent;
  border: 0;
  border-radius: 0;
  white-space: pre;
}
.mk-sample .mk-sample__code code {
  font: inherit;
  font-variant-ligatures: none;
  color: inherit;
  background: none;
  padding: 0;
}

/* The rendered side: a plain, document-like look (markoto preset
   colours, Inter body, Fraunces headings), not the page's prose. */
.mk-sample__result {
  padding: 10px 16px 16px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--ui-text);
  overflow-x: auto;
}
.mk-sample__result :deep(> :first-child) { margin-top: 0; }
.mk-sample__result :deep(> :last-child) { margin-bottom: 0; }
.mk-sample__result :deep(:is(p, ul, ol, dl, blockquote, table, pre, figure, .markdown-alert, .katex-display)) { margin: 0.6em 0; }
.mk-sample__result :deep(:is(h1, h2, h3, h4, h5, h6)) {
  font-family: var(--font-serif);
  font-weight: 400;
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin: 0.5em 0 0.3em;
}
.mk-sample__result :deep(h1) { font-size: 1.7em; }
.mk-sample__result :deep(h2) { font-size: 1.4em; }
.mk-sample__result :deep(h3) { font-size: 1.15em; }
.mk-sample__result :deep(strong) { font-weight: 600; }
.mk-sample__result :deep(a) { text-decoration: underline; text-underline-offset: 2px; }
.mk-sample__result :deep(:is(ul, ol)) { padding-left: 1.4em; }
.mk-sample__result :deep(ul) { list-style: disc; }
.mk-sample__result :deep(ol) { list-style: decimal; }
.mk-sample__result :deep(ul ul) { list-style: circle; margin: 0.2em 0; }
.mk-sample__result :deep(.contains-task-list) { list-style: none; padding-left: 0.2em; }
.mk-sample__result :deep(.task-list-item-checkbox) { margin-right: 0.4em; }
.mk-sample .mk-sample__result :deep(blockquote) {
  border-left: 3px solid var(--ui-border-accented);
  padding-left: 0.9em;
  font-family: inherit;
  font-style: normal;
  color: var(--ui-text-muted);
}
.mk-sample__result :deep(hr) { border: 0; border-top: 1px solid var(--ui-border); margin: 1em 0; }
.mk-sample__result :deep(mark) { background: color-mix(in srgb, #e9c46a 45%, transparent); color: inherit; padding: 0 2px; }
.mk-sample__result :deep(ins) { text-decoration: underline; }
.mk-sample .mk-sample__result :deep(:not(pre) > code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ui-bg-elevated);
  color: inherit;
}
/* Code blocks as in the preview: the github-dark highlight theme. */
.mk-sample .mk-sample__result :deep(pre) {
  border: 0;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
  background: #0d1117;
}
.mk-sample .mk-sample__result :deep(pre code) {
  display: block;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  background: #0d1117;
  color: #c9d1d9;
}
.mk-sample__result :deep(table) { border-collapse: collapse; width: 100%; font-size: 14px; }
.mk-sample__result :deep(:is(th, td)) { border: 1px solid var(--ui-border); padding: 4px 8px; }
.mk-sample__result :deep(th) { background: var(--ui-bg-muted); font-weight: 500; }
.mk-sample__result :deep(dt) { font-weight: 500; }
.mk-sample__result :deep(dd) { margin-left: 1.2em; color: var(--ui-text-muted); }
.mk-sample__result :deep(abbr[title]) { text-decoration: underline dotted; cursor: help; }
.mk-sample__result :deep(.footnotes) { font-size: 0.85em; color: var(--ui-text-muted); }
.mk-sample__result :deep(.footnotes-sep) { margin: 0.8em 0 0.4em; }
.mk-sample__result :deep(.table-of-contents ul) { list-style: none; padding-left: 1em; }
.mk-sample__result :deep(.table-of-contents > ul) { padding-left: 0; }
.mk-sample__result :deep(.katex-display) { overflow-x: auto; overflow-y: hidden; }

/* GitHub-style alerts in the markoto preset's muted colours. */
.mk-sample__result :deep(.markdown-alert) {
  border-left: 4px solid var(--mk-alert, #5b7a99);
  background: color-mix(in srgb, var(--mk-alert, #5b7a99) 8%, transparent);
  padding: 0.5em 0.9em;
  border-radius: 4px;
}
.mk-sample__result :deep(.markdown-alert-title) {
  color: var(--mk-alert, #5b7a99);
  font-weight: 500;
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 0.3em;
}
.mk-sample__result :deep(.markdown-alert-tip) { --mk-alert: #4f7a5a; }
.mk-sample__result :deep(.markdown-alert-important) { --mk-alert: #7a5b8c; }
.mk-sample__result :deep(.markdown-alert-warning) { --mk-alert: #9a6b1f; }
.mk-sample__result :deep(.markdown-alert-caution) { --mk-alert: #a3412c; }
</style>
