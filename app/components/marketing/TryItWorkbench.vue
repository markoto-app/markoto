<script setup lang="ts">
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markotoMarkdownHighlight } from '~/utils/markdown/markdownHighlight'
import { formattingKeymap } from '~/utils/editor/editorCommands'
import { titleFromMarkdown, tryItErrorKey, withoutTitleHeading } from '~/utils/marketing/tryIt'
import { showsTitleItself } from '~~/shared/utils/markdown/markdownTitle'
import { AnonGateCancelled } from '~/composables/account/useAnonGate'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { INITIAL_CONTENT_MAX_LENGTH } from '~~/shared/config/docCreate'

// The live half of the `::try-it` block (components/content/TryIt.vue),
// loaded only once the block is near the viewport or used. A CodeMirror
// editor (no Y.js, no sync) next to the app's paged preview:
// `useMarkdownPreview` (markdown-it + DOMPurify) → `usePagedPreview`
// (themeToCss + the sandboxed opaque-origin iframe) — the same client
// path as the editor's preview. Visitor text never reaches a server
// renderer while typing.
//
// The two actions create a real document through the normal flow
// (`useAnonDocCreate`: terms + bot check for anonymous visitors, a plain
// owned document when signed in) with the text as its `content`; the PDF
// then comes from the existing `/api/docs/:id/pdf` route (server
// renderer, its rate limit and access check). One document per text: a
// second click with unchanged text reuses it.
const props = defineProps<{
  initial: string
  themePreset?: string
  /** Document language (ISO code): preview TOC title + cover date, and the created document's language. */
  language?: string
  /** Move focus into the editor once it has mounted (the visitor clicked the static version). */
  focusOnReady?: boolean
}>()
const emit = defineEmits<{ ready: [] }>()

const { t, te } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()
const { anonDocTtlDays } = useInstanceConfig()
const anonDoc = useAnonDocCreate()

const text = ref(props.initial)
const title = computed(() => titleFromMarkdown(text.value))
const theme = computed(() => THEME_PRESETS.find(p => p.id === props.themePreset)?.theme ?? defaultTheme)
// Title-block themes (papers) set the title on page 1 themselves: the
// leading `# Title` is the document title, not body text, so it is left
// out of the preview and of the created document (whose title it becomes).
const bodyText = computed(() => {
  return showsTitleItself(theme.value.cover) ? withoutTitleHeading(text.value) : text.value
})
const tooLong = computed(() => text.value.length > INITIAL_CONTENT_MAX_LENGTH)

const editorHost = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--mk-try-it-font, 14px)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-sans)', lineHeight: '1.65' },
  '.cm-content': { padding: '14px 16px 24px' },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor', borderLeftWidth: '2px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent) !important' }
})

onMounted(() => {
  if (!editorHost.value) return
  view.value = new EditorView({
    state: EditorState.create({
      doc: text.value,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(markotoMarkdownHighlight),
        keymap.of([...formattingKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'autocapitalize': 'sentences',
          'autocorrect': 'on',
          'spellcheck': 'true',
          'aria-label': t('marketing.tryIt.editorLabel'),
          'data-testid': 'try-it-editor'
        }),
        editorTheme,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          text.value = u.state.doc.toString()
          anonDoc.prepare()
        })
      ]
    }),
    parent: editorHost.value
  })
  emit('ready')
  if (props.focusOnReady) void nextTick(() => view.value?.focus())
})

onBeforeUnmount(() => {
  view.value?.destroy()
  view.value = null
})

const { rendered } = useMarkdownPreview(bodyText)
const previewHost = ref<HTMLElement | null>(null)
const { pageCount, isReady, error: previewError } = usePagedPreview({
  html: rendered,
  theme,
  title,
  docId: ref(''),
  container: previewHost,
  language: computed(() => props.language ?? '')
})

const tab = ref<'edit' | 'preview'>('edit')

const busy = ref<'open' | 'pdf' | null>(null)
const errorKey = ref<string | null>(null)
// The document made from the current text, if any (reused on a second click).
let created: { text: string, docId: string } | null = null

const notice = computed(() => {
  if (loggedIn.value) return t('marketing.tryIt.noticeAccount')
  const n = anonDocTtlDays.value
  return n > 0
    ? t('marketing.tryIt.noticeAnon', { n }, n)
    : t('marketing.tryIt.noticeAnonKept')
})

async function ensureDocument(): Promise<string> {
  const current = text.value
  if (created && created.text === current) return created.docId
  const request: Record<string, unknown> = { content: bodyText.value }
  if (title.value) request.title = title.value
  if (props.language) request.language = props.language
  if (props.themePreset && THEME_PRESETS.some(p => p.id === props.themePreset)) request.themePreset = props.themePreset
  const docId = await anonDoc.createDocument(request)
  created = { text: current, docId }
  return docId
}

function messageFor(key: string): string {
  return te(key) ? t(key) : t('marketing.tryIt.errors.create')
}

async function openAsDocument(): Promise<void> {
  if (busy.value || tooLong.value) return
  busy.value = 'open'
  errorKey.value = null
  try {
    const docId = await ensureDocument()
    await router.push(`/d/${docId}`)
  } catch (e) {
    if (!(e instanceof AnonGateCancelled)) errorKey.value = tryItErrorKey(e, 'create')
  } finally {
    busy.value = null
  }
}

/** Navigate to the presigned PDF URL: `Content-Disposition: attachment` makes it a download. */
function startDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function downloadPdf(): Promise<void> {
  if (busy.value || tooLong.value) return
  busy.value = 'pdf'
  errorKey.value = null
  let docId: string
  try {
    docId = await ensureDocument()
  } catch (e) {
    if (!(e instanceof AnonGateCancelled)) errorKey.value = tryItErrorKey(e, 'create')
    busy.value = null
    return
  }
  try {
    const res = await apiFetch('/api/docs/:docId/pdf', {
      path: { docId },
      query: { response: 'json' },
      // One request = one render allowance (10/min): never retry a 5xx.
      retry: 0
    })
    startDownload(res.url)
  } catch (e) {
    errorKey.value = tryItErrorKey(e, 'pdf')
  } finally {
    busy.value = null
  }
}

const createdDocPath = computed(() => (errorKey.value?.startsWith('marketing.tryIt.errors.pdf') && created ? `/d/${created.docId}` : null))
</script>

<template>
  <div
    class="mk-tryw"
    :class="`is-tab-${tab}`"
    data-testid="try-it-live"
  >
    <div
      class="mk-tryw__tabs"
      role="tablist"
    >
      <button
        type="button"
        role="tab"
        class="mk-tryw__tab"
        :aria-selected="tab === 'edit'"
        data-testid="try-it-tab-edit"
        @click="tab = 'edit'"
      >
        {{ t('marketing.tryIt.tabEdit') }}
      </button>
      <button
        type="button"
        role="tab"
        class="mk-tryw__tab"
        :aria-selected="tab === 'preview'"
        data-testid="try-it-tab-preview"
        @click="tab = 'preview'"
      >
        {{ t('marketing.tryIt.tabPreview') }}
      </button>
    </div>
    <div class="mk-tryw__panes">
      <div class="mk-tryw__pane mk-tryw__pane--edit">
        <div class="mk-tryw__label">
          <span>{{ t('marketing.sample.source') }}</span>
        </div>
        <div
          ref="editorHost"
          class="mk-tryw__editor"
        />
      </div>
      <div class="mk-tryw__pane mk-tryw__pane--preview">
        <div class="mk-tryw__label">
          <span>{{ t('marketing.tryIt.preview') }}</span>
          <span
            v-if="pageCount > 0"
            data-testid="try-it-page-count"
          >{{ t('marketing.tryIt.pages', { n: pageCount }, pageCount) }}</span>
        </div>
        <div
          class="mk-tryw__preview"
          data-testid="try-it-preview"
        >
          <div
            ref="previewHost"
            class="mk-tryw__frame"
          />
          <p
            v-if="previewError"
            class="mk-tryw__overlay"
          >
            {{ t('marketing.tryIt.previewFailed') }}
          </p>
          <p
            v-else-if="!isReady"
            class="mk-tryw__overlay"
          >
            {{ t('marketing.tryIt.previewLoading') }}
          </p>
        </div>
      </div>
    </div>
    <div class="mk-tryw__actions">
      <div class="mk-tryw__buttons">
        <UButton
          color="neutral"
          :loading="busy === 'open'"
          :disabled="busy !== null || tooLong"
          data-testid="try-it-open"
          @pointerenter="anonDoc.prepare()"
          @focus="anonDoc.prepare()"
          @click="openAsDocument"
        >
          {{ t('marketing.tryIt.open') }}
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-download"
          :loading="busy === 'pdf'"
          :disabled="busy !== null || tooLong"
          data-testid="try-it-pdf"
          @pointerenter="anonDoc.prepare()"
          @focus="anonDoc.prepare()"
          @click="downloadPdf"
        >
          {{ t('marketing.tryIt.pdf') }}
        </UButton>
      </div>
      <p
        class="mk-tryw__notice"
        data-testid="try-it-notice"
      >
        {{ notice }}
      </p>
      <p
        v-if="tooLong"
        class="mk-tryw__error"
        role="alert"
      >
        {{ t('marketing.tryIt.errors.tooLong') }}
      </p>
      <p
        v-else-if="errorKey"
        class="mk-tryw__error"
        role="alert"
        data-testid="try-it-error"
      >
        {{ messageFor(errorKey) }}
        <NuxtLink
          v-if="createdDocPath"
          :to="createdDocPath"
          class="mk-tryw__error-link"
        >{{ t('marketing.tryIt.openCreated') }}</NuxtLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.mk-tryw {
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg);
}
.mk-tryw__tabs {
  display: flex;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
}
.mk-tryw__tab {
  flex: 1;
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-muted);
  border-bottom: 2px solid transparent;
}
.mk-tryw__tab[aria-selected="true"] {
  color: var(--ui-text);
  border-bottom-color: var(--ui-text);
}
.mk-tryw__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  height: min(var(--mk-try-it-h, 540px), 72vh);
}
.mk-tryw__pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Phones: one pane at a time. Both share one grid cell and the hidden one
   keeps its layout (visibility, not display: none) — paged.js inside the
   preview frame must be able to measure while the editor tab is shown. */
.mk-tryw__pane { grid-area: 1 / 1; }
.is-tab-edit .mk-tryw__pane--preview,
.is-tab-preview .mk-tryw__pane--edit {
  visibility: hidden;
}
@media (min-width: 640px) {
  .mk-tryw__tabs { display: none; }
  .mk-tryw__panes {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    height: var(--mk-try-it-h, 540px);
  }
  .mk-tryw__pane { grid-area: auto; }
  .is-tab-edit .mk-tryw__pane--preview,
  .is-tab-preview .mk-tryw__pane--edit {
    visibility: visible;
  }
  .mk-tryw__pane--preview { border-left: 1px solid var(--ui-border); }
}
.mk-tryw__pane--edit {
  background: var(--ui-bg);
  /* 16px on phones: no iOS zoom on focus. */
  --mk-try-it-font: 16px;
}
@media (min-width: 640px) {
  .mk-tryw__pane--edit { --mk-try-it-font: 14px; }
}
.mk-tryw__pane--preview { background: var(--ui-bg-muted); }
.mk-tryw__label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px 4px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}
.mk-tryw__editor {
  flex: 1;
  min-height: 0;
  color: var(--ui-text);
}
.mk-tryw__preview {
  position: relative;
  flex: 1;
  min-height: 0;
}
.mk-tryw__frame {
  position: absolute;
  inset: 0;
}
.mk-tryw__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--ui-text-muted);
  background: var(--ui-bg-muted);
  pointer-events: none;
}
.mk-tryw__actions {
  padding: 12px 14px 14px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
}
.mk-tryw__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mk-tryw__notice {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.mk-tryw__error {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-error);
}
.mk-tryw__error-link {
  margin-left: 4px;
  text-decoration: underline;
  text-underline-offset: 2px;
  color: var(--ui-text);
}
</style>
