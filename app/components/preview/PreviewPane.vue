<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import type { BrandFont } from '~~/shared/config/brandKit'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { isMacPlatform, zoomShortcutAction } from '~/utils/preview/previewZoom'
import type { CitationInputs, ReferenceProblem } from '~/utils/markdown/citationResolve'

const props = defineProps<{
  source: string
  title: string
  /** Document language: cover date, `{date}`, TOC title, chart numbers. */
  language?: string
  theme?: DocTheme
  /** Owning document: custom CSS may only reference this doc's uploads. */
  docId: string
  /** Doc JWT for session-less viewers (image access token fetch). */
  getDocJwt?: () => Promise<string | null>
  /** The workspace's brand-kit fonts. */
  brandFonts?: readonly BrandFont[] | null
  /** Show the zoom pill in the pane (desktop; mobile has it in the view-mode bar). */
  zoomControl?: boolean
  /** The document's bibliography and citation style. */
  citations?: CitationInputs | null
}>()

// Bubbled when the user presses Cmd/Ctrl+P inside the preview iframe.
// Caller wires this to the same export-PDF flow the menu item triggers,
// so the shortcut works whether focus is in the editor or the preview.
const emit = defineEmits<{ printShortcut: [], referenceProblems: [problems: ReferenceProblem[]] }>()

const pageCount = defineModel<number>('pageCount', { default: 0 })

const sourceRef = computed(() => props.source)
const titleRef = computed(() => props.title)
const languageRef = computed(() => props.language ?? '')
const themeRef = computed(() => props.theme ?? defaultTheme)

const { rendered } = useMarkdownPreview(sourceRef)
// Host element the composable will append the preview iframe into.
const iframeHost = ref<HTMLElement | null>(null)

// Preview zoom: remembered per browser, applied inside the iframe.
const zoom = usePreviewZoom()
onMounted(() => zoom.load())

const { pageCount: pgCount, isReady, error, scrollToHeading } = usePagedPreview({
  html: rendered,
  theme: themeRef,
  title: titleRef,
  language: languageRef,
  docId: computed(() => props.docId),
  container: iframeHost,
  brandFonts: computed(() => props.brandFonts ?? null),
  citations: computed(() => props.citations ?? null),
  onReferenceProblems: problems => emit('referenceProblems', problems),
  onPrintShortcut: () => emit('printShortcut'),
  getDocJwt: props.getDocJwt,
  zoom: {
    command: zoom.command,
    onRequest: (action, page) => {
      if (action === 'in') zoom.zoomIn()
      else if (action === 'out') zoom.zoomOut()
      else if (action === 'reset') zoom.fit()
      else zoom.openPage(page)
    },
    onGesture: scale => zoom.gestureEnded(scale),
    onApplied: (scale, fitScale) => zoom.reportApplied(scale, fitScale)
  }
})

// Ctrl/Cmd + = / - / 0 while the pointer is over the preview but focus
// is elsewhere (e.g. still in the editor). With focus inside the iframe
// the frame handles the keys itself. The editor binds none of these.
const pointerOver = ref(false)
useEventListener(globalThis, 'keydown', (e: KeyboardEvent) => {
  if (!pointerOver.value) return
  const action = zoomShortcutAction(e, isMacPlatform())
  if (!action) return
  e.preventDefault()
  if (action === 'in') zoom.zoomIn()
  else if (action === 'out') zoom.zoomOut()
  else zoom.fit()
}, { capture: true })

watch(pgCount, (n) => {
  pageCount.value = n
}, { immediate: true })

// The editor's outline scrolls the pages to a heading.
defineExpose({ scrollToHeading })
</script>

<template>
  <div
    role="presentation"
    class="preview-pane h-full w-full relative flex flex-col"
    @mouseenter="pointerOver = true"
    @mouseleave="pointerOver = false"
    @focusin="pointerOver = true"
    @focusout="pointerOver = false"
  >
    <!-- The zoom control sits in its own strip above the pages, never over
         them: floating over the frame it covered whatever scrolled under
         it. The strip is there from the start so the pages don't jump
         when the control appears. -->
    <div
      v-if="zoomControl"
      class="flex h-10 shrink-0 items-center justify-end bg-muted px-5"
      data-testid="preview-zoom-strip"
    >
      <PreviewZoomControl v-if="isReady && !error" />
    </div>
    <div
      ref="iframeHost"
      class="iframe-host min-h-0 w-full flex-1"
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
        {{ $t('editor.previewReloadHint') }}
      </p>
    </div>
    <div
      v-else-if="!isReady"
      class="absolute inset-0 flex items-center justify-center text-sm text-muted bg-[var(--ui-bg-muted)] pointer-events-none"
    >
      {{ $t('marketing.tryIt.previewLoading') }}
    </div>
  </div>
</template>
