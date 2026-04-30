<script setup lang="ts">
/**
 * Mobile-only "Insert" sheet — opened by the `+` button in the
 * keyboard-anchored MobileFormatBar. Lists the lower-frequency
 * inserts that don't fit in the format bar's 5-button budget:
 *
 *   • Table              insertTable
 *   • Image              file picker → upload
 *   • Code block         insertBlock with ```
 *   • Alert              opens alert-kind sub-picker (5 kinds)
 *   • Math (block)       insertMath
 *   • Diagram (mermaid)  opens diagram-kind sub-picker
 *   • Page break         insertPageBreak
 *   • Comment            create-comment event
 *
 * Renders inside the shared `<BottomSheet>` so it inherits drag-
 * dismiss + safe-area-bottom + body-scroll-lock.
 *
 * The grid is 4-up on portrait phones (390px / 4 cells ≈ 97px each
 * including gap — fits a 24px icon + 9pt label comfortably).
 */
import type { EditorView } from '@codemirror/view'
import {
  insertBlock, insertAlert, insertMath, insertDiagram, insertPageBreak
} from '~/utils/editorCommands'
import BottomSheet from '~/components/common/BottomSheet.vue'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  view: EditorView | null
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  'open-table-picker': []
  'open-image-picker': []
  'create-comment': []
}>()

function close() {
  emit('update:modelValue', false)
}

function withClose(fn: () => void): () => void {
  return () => {
    fn()
    close()
  }
}

function applyCodeBlock() {
  if (!props.view) return
  insertBlock(props.view, '```\n\n```')
}

// Alert kind sub-picker — when user taps "Alert", we replace the main
// grid with a small sub-grid for the 5 kinds. Same pattern for
// Diagram. State machine: 'main' → 'alert' → applies + closes.
type Step = 'main' | 'alert' | 'diagram'
const step = ref<Step>('main')

watch(() => props.modelValue, (open) => {
  // Reset to main view whenever the sheet opens, so users always
  // start at the top-level grid.
  if (open) step.value = 'main'
})

function applyAlert(kind: 'note' | 'tip' | 'important' | 'warning' | 'caution') {
  if (!props.view) return
  insertAlert(props.view, kind)
  close()
}

function applyDiagram(kind: 'flowchart' | 'sequence' | 'class' | 'er' | 'gantt' | 'pie') {
  if (!props.view) return
  insertDiagram(props.view, kind)
  close()
}

function applyMath() {
  if (!props.view) return
  insertMath(props.view, 'block')
  close()
}

function applyPageBreak() {
  if (!props.view) return
  insertPageBreak(props.view)
  close()
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="t('menubar.insert.title')"
    snap-height="55vh"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <!-- Top-level insert grid. 4 columns on phone widths. -->
    <div
      v-if="step === 'main'"
      class="grid grid-cols-4 gap-2 p-3"
    >
      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(() => emit('open-table-picker'))()"
      >
        <UIcon
          name="i-lucide-table"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('table.title') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(() => emit('open-image-picker'))()"
      >
        <UIcon
          name="i-lucide-image"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('image.title') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(applyCodeBlock)()"
      >
        <UIcon
          name="i-lucide-code"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('menubar.insert.codeBlock') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="step = 'alert'"
      >
        <UIcon
          name="i-lucide-alert-circle"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('menubar.insert.alert') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(applyMath)()"
      >
        <UIcon
          name="i-lucide-sigma"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('menubar.insert.math') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="step = 'diagram'"
      >
        <UIcon
          name="i-lucide-workflow"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('menubar.insert.diagram') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(applyPageBreak)()"
      >
        <UIcon
          name="i-lucide-corner-down-left"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('menubar.insert.pageBreak') }}</span>
      </button>

      <button
        type="button"
        class="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-elevated active:scale-95 transition"
        @click="withClose(() => emit('create-comment'))()"
      >
        <UIcon
          name="i-lucide-message-square"
          class="size-6 text-default"
        />
        <span class="text-xs text-muted">{{ t('comments.title') }}</span>
      </button>
    </div>

    <!-- Alert kind sub-picker -->
    <div
      v-else-if="step === 'alert'"
      class="p-3"
    >
      <button
        type="button"
        class="mb-3 inline-flex items-center gap-2 text-sm text-muted hover:text-default"
        @click="step = 'main'"
      >
        <UIcon
          name="i-lucide-arrow-left"
          class="size-4"
        />
        {{ t('common.back') }}
      </button>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="kind in (['note', 'tip', 'important', 'warning', 'caution'] as const)"
          :key="kind"
          type="button"
          class="flex flex-col items-start gap-1 p-3 rounded-lg border border-default hover:bg-elevated active:scale-95 transition"
          @click="applyAlert(kind)"
        >
          <span class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">[!{{ kind.toUpperCase() }}]</span>
          <span class="text-sm text-default">{{ t(`menubar.insert.alert${kind.charAt(0).toUpperCase() + kind.slice(1)}`) }}</span>
        </button>
      </div>
    </div>

    <!-- Diagram kind sub-picker -->
    <div
      v-else-if="step === 'diagram'"
      class="p-3"
    >
      <button
        type="button"
        class="mb-3 inline-flex items-center gap-2 text-sm text-muted hover:text-default"
        @click="step = 'main'"
      >
        <UIcon
          name="i-lucide-arrow-left"
          class="size-4"
        />
        {{ t('common.back') }}
      </button>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="kind in (['flowchart', 'sequence', 'class', 'er', 'gantt', 'pie'] as const)"
          :key="kind"
          type="button"
          class="flex flex-col items-start gap-1 p-3 rounded-lg border border-default hover:bg-elevated active:scale-95 transition"
          @click="applyDiagram(kind)"
        >
          <span class="text-sm text-default capitalize">{{ kind }}</span>
        </button>
      </div>
    </div>
  </BottomSheet>
</template>
