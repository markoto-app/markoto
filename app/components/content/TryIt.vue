<script setup lang="ts">
import { KATEX_CSS_SRI, KATEX_CSS_URL } from '~~/shared/utils/vendor/katexAssets'
import { hljsTheme } from '~~/shared/utils/vendor/hljsAssets'
import { trimTrailing } from '~/utils/markdown/trimTrailing'
import { DEFAULT_MARKETING_LOCALE, parseMarketingRoute } from '~~/shared/seo/marketing'

// A small Markdown editor next to the live paged preview, for marketing
// content (`::try-it` in content/marketing/**):
//
//   ::try-it{theme="modern" height="560"}
//   ---
//   source: |
//     # A title
//     Some **Markdown**.
//   ---
//   ::
//
// Two stages:
//   1. Static (SSR + until mounted): the committed `source` next to its
//      result, rendered on the server by `renderTrustedMarkdown` (the
//      preview's markdown-it pipeline without DOMPurify — committed
//      content only). Crawlers, no-JS readers and slow phones get real
//      content, and no editor code is loaded.
//   2. Live: once the block comes near the viewport (or the visitor
//      clicks / focuses it) `MarketingTryItWorkbench` is imported — a
//      CodeMirror editor and the app's sandboxed preview iframe. What the
//      visitor types goes ONLY through the client preview path
//      (`renderMarkdown` = markdown-it + DOMPurify, then the opaque-origin
//      iframe), never through the trusted renderer.
// No Y.js, no sync server and nothing stored while typing; the two
// actions (open as a document, download PDF) create a document through
// the normal creation flow, see the workbench.
const props = withDefaults(defineProps<{
  source: string
  /** Built-in theme preset id (`shared/utils/theme/themePresets.ts`); default theme otherwise. */
  theme?: string
  /** Height of the editor + preview in px (desktop). */
  height?: number | string
}>(), { theme: undefined, height: 540 })

const { t } = useI18n()

// Document language of the example = the page's language (`/de/…` → de),
// not the visitor's UI language: TOC title, cover date and the created
// document follow it (`shared/utils/documents/documentLocale.ts`).
const route = useRoute()
const language = computed(() => parseMarketingRoute(route.path)?.locale ?? DEFAULT_MARKETING_LOCALE)

function hashOf(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const initial = computed(() => `${trimTrailing(props.source, '\n')}\n`)
const heightPx = computed(() => {
  const n = Number(props.height)
  return Number.isFinite(n) && n >= 240 ? Math.min(n, 1200) : 540
})

// Trusted render of the COMMITTED source only (never of visitor input).
// Imported inside the callback so markdown-it stays out of this block's
// client chunk — on the client the result comes from the payload.
const { data: staticHtml } = await useAsyncData(
  `try-it:${hashOf(initial.value)}`,
  // Headings become styled <div>s (`utils/sampleHeadings.ts`): the
  // sample's "# Title" is not a heading of this page.
  () => Promise.all([import('~/utils/markdown/renderMarkdown'), import('~/utils/marketing/sampleHeadings')])
    .then(([m, h]) => m.renderTrustedMarkdown(initial.value).then(h.sampleHeadingsToDivs)),
  { default: () => '' }
)

const root = ref<HTMLElement | null>(null)
const active = ref(false)
// The workbench has mounted its editor (until then the static version shows).
const ready = ref(false)
// The visitor asked for it (click / focus): focus the editor once mounted.
const wantsFocus = ref(false)

function activate(focus: boolean): void {
  if (focus) wantsFocus.value = true
  active.value = true
}

// Near the viewport → load. 400px ahead so the editor is usually ready
// when it scrolls in; never before the page has hydrated, and never
// before the page has finished loading and the main thread is idle: the
// workbench is ~300 KB gzip of JS, and on a page that opens with the
// block (/markdown-to-pdf) it competed with the first paint. A click or
// focus (activate(true)) loads it at once.
let observer: IntersectionObserver | null = null
let idleHandle: number | null = null
let timeoutHandle: ReturnType<typeof setTimeout> | null = null
let cancelled = false
function whenIdle(fn: () => void): void {
  const run = (): void => {
    if (cancelled) return
    if (typeof globalThis.requestIdleCallback === 'function') idleHandle = globalThis.requestIdleCallback(fn, { timeout: 2000 })
    else timeoutHandle = setTimeout(fn, 200)
  }
  if (document.readyState === 'complete') run()
  else globalThis.addEventListener('load', run, { once: true })
}
onMounted(() => {
  const el = root.value
  if (!el) return
  whenIdle(() => {
    if (cancelled || active.value) return
    if (typeof IntersectionObserver === 'undefined') {
      activate(false)
      return
    }
    observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        observer?.disconnect()
        activate(false)
      }
    }, { rootMargin: '400px 0px' })
    observer.observe(el)
  })
})
onBeforeUnmount(() => {
  cancelled = true
  observer?.disconnect()
  if (idleHandle !== null && typeof globalThis.cancelIdleCallback === 'function') globalThis.cancelIdleCallback(idleHandle)
  if (timeoutHandle !== null) clearTimeout(timeoutHandle)
})

// Stylesheets the static result needs (same as `::sample`).
const CODE_THEME = hljsTheme('github-dark')
const ANONYMOUS = 'anonymous' as const
const STYLESHEET = 'stylesheet' as const
useHead(() => ({
  link: [
    ...(staticHtml.value.includes('class="katex')
      ? [{ key: 'katex-css', rel: STYLESHEET, href: KATEX_CSS_URL, integrity: KATEX_CSS_SRI, crossorigin: ANONYMOUS }]
      : []),
    ...(staticHtml.value.includes('class="hljs')
      ? [{ key: 'hljs-css', rel: STYLESHEET, href: CODE_THEME.url, integrity: CODE_THEME.sri, crossorigin: ANONYMOUS }]
      : [])
  ]
}))
</script>

<template>
  <section
    ref="root"
    class="mk-try-it mk-wide not-prose"
    :style="{ '--mk-try-it-h': `${heightPx}px` }"
    :data-state="ready ? 'live' : 'static'"
    data-testid="try-it"
  >
    <!-- Mounted hidden over the static version, which stays until the
         editor is ready: no empty flash, no layout jump while the chunk
         loads. -->
    <LazyMarketingTryItWorkbench
      v-if="active"
      :class="{ 'mk-try-it__pending': !ready }"
      :initial="initial"
      :theme-preset="theme"
      :language="language"
      :focus-on-ready="wantsFocus"
      @ready="ready = true"
    />
    <div
      v-if="!ready"
      class="mk-try-it__static"
      data-testid="try-it-static"
    >
      <div class="mk-try-it__pane mk-try-it__pane--source">
        <div class="mk-try-it__label">
          <span>{{ t('marketing.sample.source') }}</span>
        </div>
        <pre
          class="mk-try-it__code"
          tabindex="0"
          @focus="activate(true)"
          @pointerdown="activate(true)"
        ><code>{{ initial }}</code></pre>
        <div class="mk-try-it__start">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-pencil"
            data-testid="try-it-start"
            @click="activate(true)"
          >
            {{ t('marketing.tryIt.start') }}
          </UButton>
        </div>
      </div>
      <div class="mk-try-it__pane mk-try-it__pane--result">
        <div class="mk-try-it__label">
          <span>{{ t('marketing.sample.result') }}</span>
        </div>
        <!-- Rendered from committed content only (renderTrustedMarkdown). -->
        <!-- eslint-disable vue/no-v-html -- committed content, never visitor input (renderTrustedMarkdown) -->
        <div
          class="mk-try-it__result"
          data-testid="try-it-static-result"
          v-html="staticHtml"
        />
        <!-- eslint-enable vue/no-v-html -->
      </div>
    </div>
  </section>
</template>

<style scoped>
.mk-try-it {
  position: relative;
  margin: 28px 0 36px;
}
.mk-try-it__pending {
  position: absolute;
  inset: 0 0 auto;
  visibility: hidden;
}
.mk-try-it__static {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg);
}
@media (min-width: 640px) {
  .mk-try-it__static {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    height: var(--mk-try-it-h);
  }
  .mk-try-it__pane--result { border-top: 0; border-left: 1px solid var(--ui-border); }
}
.mk-try-it__pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mk-try-it__pane--source { background: var(--ui-bg-elevated); }
.mk-try-it__pane--result {
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.mk-try-it__label {
  padding: 8px 14px 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}
.mk-try-it .mk-try-it__code {
  flex: 1;
  min-height: 0;
  max-height: 360px;
  margin: 0;
  padding: 10px 14px 14px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  font-variant-ligatures: none;
  color: var(--ui-text);
  background: transparent;
  border: 0;
  border-radius: 0;
  white-space: pre-wrap;
  cursor: text;
}
@media (min-width: 640px) {
  .mk-try-it .mk-try-it__code { max-height: none; }
}
.mk-try-it .mk-try-it__code code {
  font: inherit;
  color: inherit;
  background: none;
  padding: 0;
}
.mk-try-it__start {
  padding: 10px 14px 14px;
  border-top: 1px solid var(--ui-border);
}
/* A plain page-like look until the paged preview takes over. */
.mk-try-it__result {
  flex: 1;
  min-height: 0;
  max-height: 420px;
  margin: 10px 14px 14px;
  padding: 24px 28px;
  overflow: auto;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--ui-text);
}
@media (min-width: 640px) {
  .mk-try-it__result { max-height: none; }
}
.mk-try-it__result :deep(> :first-child) { margin-top: 0; }
.mk-try-it__result :deep(:is(p, ul, ol, blockquote, table, pre)) { margin: 0.6em 0; }
.mk-try-it__result :deep(:where(.mk-sample-h)) {
  font-family: var(--font-serif);
  font-weight: 400;
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin: 0.6em 0 0.3em;
  /* Heading ink, as `.prose h1–h4` gave the <h*> these used to be. */
  color: var(--color-sumi-950);
}
html.dark .mk-try-it__result :deep(:where(.mk-sample-h)) { color: var(--color-sumi-50); }
.mk-try-it__result :deep(:where(.mk-sample-h1)) { font-size: 1.7em; }
.mk-try-it__result :deep(:where(.mk-sample-h2)) { font-size: 1.35em; }
.mk-try-it__result :deep(:where(.mk-sample-h3)) { font-size: 1.15em; }
.mk-try-it__result :deep(strong) { font-weight: 500; }
.mk-try-it__result :deep(:is(ul, ol)) { padding-left: 1.4em; }
.mk-try-it__result :deep(ul) { list-style: disc; }
.mk-try-it__result :deep(ol) { list-style: decimal; }
.mk-try-it__result :deep(.contains-task-list) { list-style: none; padding-left: 0.2em; }
.mk-try-it__result :deep(input[type="checkbox"]) { accent-color: var(--ui-text); margin-right: 0.4em; }
.mk-try-it__result :deep(table) { border-collapse: collapse; font-size: 14px; }
.mk-try-it__result :deep(:is(th, td)) { border: 1px solid var(--ui-border); padding: 4px 8px; }
.mk-try-it__result :deep(th) { font-weight: 500; }
.mk-try-it__result :deep(blockquote) {
  border-left: 3px solid var(--ui-border-accented);
  padding-left: 0.9em;
  color: var(--ui-text-muted);
}
.mk-try-it__result :deep(:not(pre) > code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ui-bg-elevated);
}
.mk-try-it__result :deep(pre) {
  overflow-x: auto;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--ui-bg-elevated);
}
.mk-try-it__result :deep(.markdown-alert) {
  border-left: 4px solid var(--ui-border-accented);
  padding: 0.5em 0.9em;
}
.mk-try-it__result :deep(.footnotes) { font-size: 0.85em; color: var(--ui-text-muted); }
</style>
