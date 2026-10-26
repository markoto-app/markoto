<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'

const props = defineProps<{
  source: string
  title: string
  theme?: DocTheme
  /** Owning document — custom CSS may only reference this doc's uploads. */
  docId: string
}>()

// Bubbled when the user presses Cmd/Ctrl+P inside the preview iframe.
// Caller wires this to the same export-PDF flow the menu item triggers,
// so the shortcut works whether focus is in the editor or the preview.
const emit = defineEmits<{ printShortcut: [] }>()

const pageCount = defineModel<number>('pageCount', { default: 0 })

const sourceRef = computed(() => props.source)
const titleRef = computed(() => props.title)
const themeRef = computed(() => props.theme ?? defaultTheme)

const { rendered } = useMarkdownPreview(sourceRef)
// Host element the composable will append the preview iframe into.
const iframeHost = ref<HTMLElement | null>(null)

const { pageCount: pgCount, isReady, error } = usePagedPreview({
  html: rendered,
  theme: themeRef,
  title: titleRef,
  docId: computed(() => props.docId),
  container: iframeHost,
  onPrintShortcut: () => emit('printShortcut')
})

watch(pgCount, (n) => {
  pageCount.value = n
}, { immediate: true })
</script>

<template>
  <div class="preview-pane h-full w-full relative">
    <div
      ref="iframeHost"
      class="iframe-host h-full w-full"
    />
    <div
      v-if="error"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-amber-700 dark:text-amber-400 bg-[var(--ui-bg-muted)]"
    >
      <UIcon
        name="i-lucide-alert-triangle"
        class="size-6"
      />
      <p>{{ error }}</p>
      <p class="text-xs text-muted">
        Reload the page to retry.
      </p>
    </div>
    <div
      v-else-if="!isReady"
      class="absolute inset-0 flex items-center justify-center text-sm text-muted bg-[var(--ui-bg-muted)] pointer-events-none"
    >
      Loading preview…
    </div>
  </div>
</template>
