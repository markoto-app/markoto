<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import {
  CUSTOM_CSS_MAX_BYTES,
  customCssByteLength,
  type CustomCssIssue
} from '~~/shared/types/customCss'
import { loadCustomCssSanitizer, currentAppOrigins } from '~/utils/preview/customCssLoader'

/**
 * "Custom CSS" section of the theme panel. A small CodeMirror 6 editor
 * (CSS mode) whose text is checked with the same sanitizer the server
 * and every renderer use. Valid CSS is emitted upstream (→ `ymeta.theme`
 * + the owner's debounced DB persist), so the preview updates live;
 * while the text has errors nothing is emitted — the last valid CSS
 * stays applied and the errors are listed under the editor.
 *
 * Everything heavy (CodeMirror CSS mode, css-tree) is loaded the first
 * time the section scrolls into view, not when the panel opens.
 */
const props = defineProps<{
  modelValue: string | undefined
  docId: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const { t, locale } = useI18n()

const host = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const text = ref(props.modelValue ?? '')
const issues = ref<CustomCssIssue[]>([])
const status = ref<'idle' | 'checking' | 'applied' | 'invalid'>('idle')

/** Last value we emitted, so our own echo through props isn't treated as a remote edit. */
let lastEmitted = props.modelValue ?? ''

const bytes = computed(() => customCssByteLength(text.value))
const overLimit = computed(() => bytes.value > CUSTOM_CSS_MAX_BYTES)
const numberFormat = computed(() => new Intl.NumberFormat(locale.value))

let checkSeq = 0
async function check(value: string) {
  const seq = ++checkSeq
  status.value = 'checking'
  const { sanitizeCustomCss } = await loadCustomCssSanitizer()
  if (seq !== checkSeq) return
  const result = sanitizeCustomCss(value, { docId: props.docId, allowedOrigins: currentAppOrigins() })
  issues.value = result.issues
  if (result.issues.length > 0) {
    status.value = 'invalid'
    return
  }
  status.value = value.trim() === '' ? 'idle' : 'applied'
  if (value !== lastEmitted) {
    lastEmitted = value
    emit('update:modelValue', value)
  }
}

const debouncedCheck = useDebounceFn((value: string) => {
  check(value).catch((err: unknown) => {
    console.warn('[custom css] check failed', err)
    status.value = 'idle'
  })
}, 400)

watch(text, value => debouncedCheck(value))

// Remote edit (collaborator, AI, preset applied in this panel): replace
// the editor content unless it is just our own value coming back.
watch(() => props.modelValue, (next) => {
  const value = next ?? ''
  if (value === lastEmitted || value === text.value) return
  lastEmitted = value
  text.value = value
  const v = view.value
  if (v && v.state.doc.toString() !== value) {
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }
})

async function mountEditor() {
  if (view.value || !host.value) return
  const [
    { EditorView: View, keymap, lineNumbers, drawSelection },
    { EditorState },
    { css },
    { defaultKeymap, history, historyKeymap, indentWithTab },
    { HighlightStyle, syntaxHighlighting, bracketMatching },
    { tags }
  ] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/lang-css'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@lezer/highlight')
  ])
  if (view.value || !host.value) return
  // Tags as @lezer/css emits them; colours are CSS variables in
  // main.css (`--mk-css-*`, light + dark).
  const highlight = HighlightStyle.define([
    {
      tag: [tags.tagName, tags.className, tags.constant(tags.className), tags.labelName, tags.definitionOperator, tags.namespace],
      color: 'var(--mk-css-selector)'
    },
    { tag: [tags.propertyName, tags.attributeName], color: 'var(--mk-css-property)' },
    {
      tag: [tags.definitionKeyword, tags.keyword, tags.operatorKeyword, tags.modifier, tags.variableName],
      color: 'var(--mk-css-at)'
    },
    { tag: [tags.number, tags.unit, tags.color], color: 'var(--mk-css-number)' },
    { tag: tags.string, color: 'var(--mk-css-string)' },
    { tag: tags.atom, color: 'var(--ui-text)' },
    {
      tag: [tags.punctuation, tags.separator, tags.brace, tags.paren, tags.squareBracket, tags.derefOperator, tags.logicOperator, tags.compareOperator, tags.arithmeticOperator],
      color: 'var(--mk-css-punct)'
    },
    { tag: [tags.comment, tags.blockComment], color: 'var(--mk-md-comment)' }
  ])
  view.value = new View({
    parent: host.value,
    state: EditorState.create({
      doc: text.value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        css(),
        syntaxHighlighting(highlight),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        View.lineWrapping,
        View.contentAttributes.of({ 'aria-label': t('theme.customCss.editorLabel'), 'spellcheck': 'false' }),
        View.updateListener.of((u) => {
          if (u.docChanged) text.value = u.state.doc.toString()
        }),
        View.theme({
          '&': { fontSize: '12px', maxHeight: '22rem', minHeight: '8rem' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--ui-text-muted)' },
          '.cm-cursor': { borderLeftColor: 'currentColor' },
          '.cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent) !important' }
        })
      ]
    })
  })
  // Show existing problems straight away (e.g. CSS written over Y.js).
  if (text.value.trim() !== '') void debouncedCheck(text.value)
}

useIntersectionObserver(host, ([entry]) => {
  if (entry?.isIntersecting) {
    mountEditor().catch((err: unknown) => console.warn('[custom css] editor failed to load', err))
  }
})

onBeforeUnmount(() => {
  view.value?.destroy()
  view.value = null
})

const examples = computed(() => [
  {
    id: 'pageNumber',
    label: t('theme.customCss.example.pageNumber'),
    code: '@page {\n  @bottom-center {\n    content: counter(page) " / " counter(pages);\n  }\n}'
  },
  {
    id: 'h1',
    label: t('theme.customCss.example.h1'),
    code: '.paged-doc h1 {\n  font-size: 2.4em;\n  letter-spacing: -0.02em;\n  border-bottom: 1px solid currentColor;\n}'
  },
  {
    id: 'blockquote',
    label: t('theme.customCss.example.blockquote'),
    code: '.paged-doc blockquote {\n  background: #f4f1ea;\n  border-left: 3px solid #8a8070;\n  padding: 0.6em 1em;\n}'
  }
])

function insertExample(code: string) {
  const v = view.value
  const current = v ? v.state.doc.toString() : text.value
  const prefix = current.trim() === '' ? '' : (current.endsWith('\n') ? '\n' : '\n\n')
  if (v) {
    const from = v.state.doc.length
    v.dispatch({ changes: { from, insert: prefix + code + '\n' }, selection: { anchor: from + prefix.length + code.length + 1 } })
    v.focus()
  } else {
    text.value = current + prefix + code + '\n'
  }
}

function issueText(issue: CustomCssIssue): string {
  const key = `theme.customCss.issue.${issue.code}`
  return t(key, { detail: issue.detail ?? '' })
}
</script>

<template>
  <div
    class="space-y-3 pt-2 pb-4"
    data-testid="theme-custom-css"
  >
    <p class="text-xs text-muted leading-relaxed">
      {{ t('theme.customCss.help') }}
    </p>
    <!-- New tab: following it in place would leave the editor. -->
    <a
      href="/docs/themes/custom-css"
      target="_blank"
      rel="noopener"
      class="inline-flex items-center gap-1.5 text-xs text-default underline decoration-default underline-offset-2 hover:decoration-current"
      data-testid="theme-custom-css-docs-link"
    >
      <UIcon
        name="i-lucide-book-open"
        class="size-3.5 text-muted"
      />
      {{ t('theme.customCss.docsLink') }}
    </a>

    <div
      ref="host"
      class="rounded-md border bg-default overflow-hidden"
      :class="status === 'invalid' || overLimit ? 'border-error/60' : 'border-default'"
      data-testid="theme-custom-css-editor"
    />

    <div class="flex items-center justify-between gap-2 font-mono text-[10.5px] lowercase tracking-[0.04em] text-muted">
      <span data-testid="theme-custom-css-status">
        <template v-if="status === 'checking'">{{ t('theme.customCss.checking') }}</template>
        <template v-else-if="status === 'applied'">{{ t('theme.customCss.applied') }}</template>
        <template v-else-if="status === 'invalid'">{{ t('theme.customCss.notApplied') }}</template>
      </span>
      <span
        :class="overLimit ? 'text-error' : ''"
        data-testid="theme-custom-css-bytes"
      >
        {{ t('theme.customCss.bytes', { used: numberFormat.format(bytes), max: numberFormat.format(CUSTOM_CSS_MAX_BYTES) }) }}
      </span>
    </div>

    <ul
      v-if="issues.length > 0"
      class="space-y-1.5"
      data-testid="theme-custom-css-issues"
    >
      <li
        v-for="(issue, idx) in issues"
        :key="idx"
        class="text-xs text-error leading-snug"
      >
        <span class="font-mono text-[10.5px] tracking-[0.04em]">
          {{ t('theme.customCss.position', { line: issue.line, column: issue.column }) }}
        </span>
        <span class="mx-1">·</span>
        {{ issueText(issue) }}
      </li>
    </ul>

    <p class="text-xs text-muted leading-relaxed">
      {{ t('theme.customCss.imagesHint') }}
    </p>

    <div>
      <h5 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted mb-2">
        {{ t('theme.customCss.examplesTitle') }}
      </h5>
      <div class="space-y-2">
        <div
          v-for="ex in examples"
          :key="ex.id"
          class="rounded-md border border-default bg-default"
        >
          <div class="flex items-center justify-between gap-2 px-2.5 pt-2">
            <span class="text-xs">{{ ex.label }}</span>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-plus"
              :data-testid="`theme-custom-css-example-${ex.id}`"
              @click="insertExample(ex.code)"
            >
              {{ t('theme.customCss.insert') }}
            </UButton>
          </div>
          <pre class="px-2.5 pb-2 pt-1 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap break-words">{{ ex.code }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
