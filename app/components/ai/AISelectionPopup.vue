<script setup lang="ts">
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import type { Text as YText } from 'yjs'

const props = defineProps<{
  view: EditorView | null
  ytext: YText
  onRewrite: (params: {
    selectionText: string
    selectionFrom: number
    selectionTo: number
    relFrom: any
    relTo: any
    instruction: string
  }) => Promise<boolean>
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()

// Popup state
const visible = ref(false)     // is the popup rendered
const expanded = ref(false)    // is the text input shown (vs the sparkles pill)
const submitting = ref(false)
const instruction = ref('')
const popupX = ref(0)
const popupY = ref(0)

// Cached selection at the moment we show the popup — don't rely on `view` at submit time,
// because the selection may have changed.
interface CapturedSelection {
  text: string
  from: number
  to: number
  relFrom: any
  relTo: any
}
const captured = ref<CapturedSelection | null>(null)

const inputEl = ref<HTMLInputElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)

// Dismiss on any click outside the popup — including clicks inside the editor,
// which is the natural way users collapse a selection. If the click produces a
// new non-empty selection, the `selectionchange` handler re-shows the popup at
// the new position.
onClickOutside(popupEl, () => hide())

function hide() {
  visible.value = false
  expanded.value = false
  instruction.value = ''
  captured.value = null
}

function reposition(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return

  // Position near the end of the selection (below the last line).
  const coords = view.coordsAtPos(sel.to)
  if (!coords) return

  // Account for the editor container's bounding rect so absolute positioning
  // lands correctly relative to the viewport-positioned parent (we position
  // relative to the document body).
  popupX.value = Math.max(8, coords.left - 8)
  popupY.value = coords.bottom + 4
}

function captureSelection(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return null
  const text = view.state.sliceDoc(sel.from, sel.to).trim()
  if (!text) return null

  let relFrom: any = null
  let relTo: any = null
  try {
    relFrom = Y.createRelativePositionFromTypeIndex(props.ytext, sel.from)
    relTo = Y.createRelativePositionFromTypeIndex(props.ytext, sel.to)
  } catch { /* ignore — we'll fall back to raw indices on the server */ }

  return {
    text,
    from: sel.from,
    to: sel.to,
    relFrom: relFrom ? JSON.parse(JSON.stringify(relFrom)) : null,
    relTo: relTo ? JSON.parse(JSON.stringify(relTo)) : null
  } as CapturedSelection
}

// Watch selection changes on the editor
let removeSelectionListener: (() => void) | null = null

function attachListener(view: EditorView) {
  const handler = () => {
    if (expanded.value) return // don't churn while user is typing a rewrite
    const sel = view.state.selection.main
    if (sel.empty || !loggedIn.value) {
      if (visible.value && !expanded.value) hide()
      return
    }
    const text = view.state.sliceDoc(sel.from, sel.to).trim()
    if (!text) {
      if (visible.value && !expanded.value) hide()
      return
    }
    visible.value = true
    expanded.value = false
    reposition(view)
  }

  // CM6 doesn't emit a "selection change" event directly; we use an update listener
  // via a DOM "selectionchange" fallback is tricky, so hook into the editor by
  // dispatching a plugin on focus/selection via the content element's "selectionchange".
  const contentEl = view.contentDOM
  const onSelChange = () => handler()
  const onBlur = () => {
    // Let clicks on the popup itself still work — defer hide
    setTimeout(() => {
      if (document.activeElement && document.activeElement.closest('.ai-selection-popup')) return
      if (!expanded.value) hide()
    }, 120)
  }

  document.addEventListener('selectionchange', onSelChange)
  contentEl.addEventListener('blur', onBlur)

  removeSelectionListener = () => {
    document.removeEventListener('selectionchange', onSelChange)
    contentEl.removeEventListener('blur', onBlur)
  }
}

watch(() => props.view, (view) => {
  if (removeSelectionListener) {
    removeSelectionListener()
    removeSelectionListener = null
  }
  if (view) attachListener(view)
}, { immediate: true })

onUnmounted(() => {
  if (removeSelectionListener) removeSelectionListener()
})

async function onActivate() {
  if (!props.view) return
  const snap = captureSelection(props.view)
  if (!snap) { hide(); return }
  captured.value = snap
  expanded.value = true
  await nextTick()
  inputEl.value?.focus()
}

async function onSubmit() {
  if (!captured.value || submitting.value) return
  const text = instruction.value.trim()
  if (!text) return

  submitting.value = true
  try {
    const ok = await props.onRewrite({
      selectionText: captured.value.text,
      selectionFrom: captured.value.from,
      selectionTo: captured.value.to,
      relFrom: captured.value.relFrom,
      relTo: captured.value.relTo,
      instruction: text
    })
    if (ok) {
      hide()
    } else {
      toast.add({
        title: t('ai.failed'),
        description: '',
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
  } finally {
    submitting.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    hide()
  }
}
</script>

<template>
  <div
    v-if="visible && loggedIn"
    ref="popupEl"
    class="ai-selection-popup fixed z-50"
    :style="{ left: popupX + 'px', top: popupY + 'px' }"
    @mousedown.stop
    @click.stop
  >
    <div v-if="!expanded">
      <UButton
        size="xs"
        color="warning"
        variant="solid"
        icon="i-lucide-sparkles"
        class="shadow-md"
        @click="onActivate"
      >
        {{ t('ai.rewriteButton') }}
      </UButton>
    </div>
    <div
      v-else
      class="flex items-center gap-1 rounded-md border border-amber-500/40 bg-[var(--ui-bg-elevated)] shadow-xl p-1"
    >
      <UIcon name="i-lucide-sparkles" class="size-4 text-amber-500 mx-1 shrink-0" />
      <input
        ref="inputEl"
        v-model="instruction"
        type="text"
        :placeholder="t('ai.rewritePlaceholder')"
        class="w-72 bg-transparent outline-none text-sm text-default placeholder:text-muted"
        :disabled="submitting"
        @keydown.enter="onSubmit"
        @keydown="onKeydown"
      >
      <UButton
        size="xs"
        color="primary"
        icon="i-lucide-send"
        :loading="submitting"
        :disabled="!instruction.trim()"
        @click="onSubmit"
      />
    </div>
  </div>
</template>
