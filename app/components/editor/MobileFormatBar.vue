<script setup lang="ts">
/**
 * Mobile-only formatting bar — anchored above the virtual keyboard
 * via `visualViewport`. Replaces the desktop EditorToolbar's
 * flex-wrapping strip on `<sm`.
 *
 * Contents (the 80%-case list — picked for "what does a mobile writer
 * reach for next while typing?"):
 *   [Bold] [Italic] [H↻] [List↻] [Link]   …    [+]
 *
 * The `H↻` button cycles through h1 → h2 → h3 → body, cheaper than
 * 3 distinct buttons and matches what most mobile editors do.
 * Same for `List↻` (bullet → numbered → task → off).
 *
 * The `+` button opens the InsertSheet (separate component) for
 * lower-frequency actions: tables, alerts, math, mermaid, page break,
 * comments, code blocks, image upload.
 *
 * Visibility: the bar is mounted (DOM) whenever the editor is editable,
 * but only visually shown when the virtual keyboard is up. We detect
 * that by watching `visualViewport.height` falling below the static
 * `window.innerHeight` — the gap is the keyboard's intrusion.
 *
 * Position: fixed to the bottom of the visualViewport. On iOS, the
 * keyboard pushes the visualViewport up; we re-anchor the bar to its
 * new bottom on `resize` / `scroll` events.
 */
import type { EditorView } from '@codemirror/view'
import { toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList } from '~/utils/editorCommands'

const { t } = useI18n()

const props = defineProps<{
  view: EditorView | null
  readOnly: boolean
  /**
   * Live dictation state, hoisted from `useVoiceDictation` in the
   * parent. 'idle' → mic icon. Any other value → an active session;
   * the button styles itself as "stop" for clarity.
   */
  dictationState?: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'error'
}>()

const emit = defineEmits<{
  'open-insert-sheet': []
  'toggle-dictation': []
}>()

const dictationActive = computed(() =>
  props.dictationState === 'recording' || props.dictationState === 'connecting'
)

// Viewport-tracking — the visual viewport differs from window when
// the virtual keyboard is up. We position the bar with `bottom: <gap
// from keyboard top>px` derived from those.
const keyboardOffset = ref(0)
const keyboardOpen = ref(false)

function updateViewport() {
  if (typeof window === 'undefined' || !window.visualViewport) return
  const vv = window.visualViewport
  // Distance from the bottom of `window` to the bottom of the visual
  // viewport. Positive when the keyboard pushes content up.
  const gap = window.innerHeight - vv.height - vv.offsetTop
  keyboardOffset.value = Math.max(0, gap)
  // "Keyboard is open" heuristic: the gap is meaningfully larger than
  // browser chrome adjustments. 80px filters out iOS Safari's URL-bar
  // hide/show without false-positiving on real keyboards.
  keyboardOpen.value = keyboardOffset.value > 80
}

onMounted(() => {
  if (typeof window === 'undefined' || !window.visualViewport) return
  window.visualViewport.addEventListener('resize', updateViewport)
  window.visualViewport.addEventListener('scroll', updateViewport)
  updateViewport()
})

onUnmounted(() => {
  if (typeof window === 'undefined' || !window.visualViewport) return
  window.visualViewport.removeEventListener('resize', updateViewport)
  window.visualViewport.removeEventListener('scroll', updateViewport)
})

// Heading cycle state — track the current "level" we'd apply on tap.
// We rotate h1 → h2 → h3 → body. The persistent state is intentional
// (writers tap repeatedly); after applying, the cycle advances.
const headingCycleStep = ref(0)
const headingLevels: Array<{ level: number, label: string }> = [
  { level: 1, label: 'H1' },
  { level: 2, label: 'H2' },
  { level: 3, label: 'H3' },
  { level: 0, label: '¶' } // 0 means "remove heading" — toggleHeading with 0 strips it
]
const currentHeadingLabel = computed(() => headingLevels[headingCycleStep.value]!.label)

function cycleHeading() {
  if (!props.view) return
  const next = headingLevels[headingCycleStep.value]!
  if (next.level === 0) {
    // Strip — we cycle through and on the "body" step we toggle off
    // by re-applying the previous level (toggleHeading toggles).
    const prev = headingLevels[(headingCycleStep.value + 3) % 4]!
    toggleHeading(props.view, prev.level)
  } else {
    toggleHeading(props.view, next.level)
  }
  headingCycleStep.value = (headingCycleStep.value + 1) % 4
}

// List cycle — bullets → numbered → off. Sequencing matches the
// heading cycle's UX: tap to advance.
const listCycleStep = ref(0)
const listSteps: Array<{ apply: (v: EditorView) => void, label: string, icon: string }> = [
  {
    apply: (v) => toggleLinePrefix(v, '- '),
    label: 'Bullet list',
    icon: 'i-lucide-list'
  },
  {
    apply: (v) => toggleOrderedList(v),
    label: 'Numbered list',
    icon: 'i-lucide-list-ordered'
  }
]
const currentListIcon = computed(() => listSteps[listCycleStep.value]!.icon)
const currentListLabel = computed(() => listSteps[listCycleStep.value]!.label)

function cycleList() {
  if (!props.view) return
  listSteps[listCycleStep.value]!.apply(props.view)
  listCycleStep.value = (listCycleStep.value + 1) % listSteps.length
}

function bold() {
  if (!props.view) return
  toggleWrap(props.view, '**')
}
function italic() {
  if (!props.view) return
  toggleWrap(props.view, '_')
}
function link() {
  // Insert `[](url)` and rely on user to fill. Simpler than the desktop
  // 2-step modal flow, fits mobile's tap-budget. The backwards bracket
  // navigation is slightly awkward but matches what iA Writer does.
  if (!props.view) return
  const sel = props.view.state.selection.main
  const text = props.view.state.doc.sliceString(sel.from, sel.to) || ''
  props.view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `[${text}](url)` },
    selection: { anchor: sel.from + text.length + 3, head: sel.from + text.length + 6 }
  })
  props.view.focus()
}
</script>

<template>
  <!-- Hidden on `>=sm` — the desktop toolbar handles those breakpoints.
       Hidden when readOnly (no edits possible). Hidden when the
       keyboard is closed — the bar would otherwise float above an
       empty area; we surface it only when the user is actively typing. -->
  <div
    v-if="!readOnly && keyboardOpen"
    class="sm:hidden fixed left-0 right-0 z-40 flex items-center justify-between gap-1 px-2 py-1.5 bg-default border-t border-default"
    :style="{ bottom: `${keyboardOffset}px` }"
    data-testid="mobile-format-bar"
  >
    <div class="flex items-center gap-0.5">
      <!-- Live dictation. Visually distinct from the AI prompt bar's
           voice mic (that one transcribes a one-shot prompt; this one
           streams into the editor in real time). When recording, the
           icon flips to a stop affordance so it doesn't look like a
           "tap to start again" button. -->
      <button
        type="button"
        class="size-9 inline-flex items-center justify-center rounded-md transition-colors"
        :class="dictationActive
          ? 'bg-shu-500 text-white'
          : 'text-muted hover:text-default active:bg-elevated'"
        :aria-label="dictationActive ? 'Stop dictation' : 'Start dictation'"
        @mousedown.prevent
        @click="emit('toggle-dictation')"
      >
        <UIcon
          :name="dictationActive ? 'i-lucide-square' : 'i-lucide-mic'"
          class="size-4"
        />
      </button>
      <button
        type="button"
        class="size-9 inline-flex items-center justify-center rounded-md text-muted hover:text-default active:bg-elevated"
        :aria-label="'Bold'"
        @mousedown.prevent
        @click="bold"
      >
        <UIcon name="i-lucide-bold" class="size-4" />
      </button>
      <button
        type="button"
        class="size-9 inline-flex items-center justify-center rounded-md text-muted hover:text-default active:bg-elevated"
        :aria-label="'Italic'"
        @mousedown.prevent
        @click="italic"
      >
        <UIcon name="i-lucide-italic" class="size-4" />
      </button>
      <button
        type="button"
        class="min-w-9 h-9 px-2 inline-flex items-center justify-center rounded-md text-muted hover:text-default active:bg-elevated font-mono text-xs"
        :aria-label="`Heading: ${currentHeadingLabel}`"
        @mousedown.prevent
        @click="cycleHeading"
      >
        {{ currentHeadingLabel }}
      </button>
      <button
        type="button"
        class="size-9 inline-flex items-center justify-center rounded-md text-muted hover:text-default active:bg-elevated"
        :aria-label="currentListLabel"
        @mousedown.prevent
        @click="cycleList"
      >
        <UIcon :name="currentListIcon" class="size-4" />
      </button>
      <button
        type="button"
        class="size-9 inline-flex items-center justify-center rounded-md text-muted hover:text-default active:bg-elevated"
        :aria-label="'Link'"
        @mousedown.prevent
        @click="link"
      >
        <UIcon name="i-lucide-link" class="size-4" />
      </button>
    </div>

    <button
      type="button"
      class="size-9 inline-flex items-center justify-center rounded-md text-default bg-elevated hover:bg-muted active:scale-95"
      :aria-label="t('menubar.insert.title')"
      data-testid="mobile-format-bar-insert"
      @mousedown.prevent
      @click="emit('open-insert-sheet')"
    >
      <UIcon name="i-lucide-plus" class="size-5" />
    </button>
  </div>
</template>
