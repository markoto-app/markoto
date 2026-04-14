<script setup lang="ts">
import type { EditorView } from '@codemirror/view'

const props = defineProps<{
  docId: string
  editorView: EditorView | null
  readOnly: boolean
}>()

const { t } = useI18n()
const { uploadAndInsert, uploading, error } = useImageUpload(props.docId)
const toast = useToast()
const dragging = ref(false)
const containerRef = ref<HTMLElement | null>(null)

watch(error, (err) => {
  if (!err) return
  if (err === 'login_required') {
    toast.add({
      title: t('auth.loginRequired'),
      description: t('image.loginToUpload'),
      icon: 'i-lucide-log-in',
      color: 'warning'
    })
  } else {
    toast.add({
      title: t('image.uploadFailed'),
      description: err,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
})

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

function isImageFile(file: File): boolean {
  return ALLOWED_TYPES.has(file.type)
}

function handleDragOver(e: DragEvent) {
  if (props.readOnly) return
  e.preventDefault()
  dragging.value = true
}

function handleDragLeave() {
  dragging.value = false
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragging.value = false
  if (props.readOnly || !props.editorView) return

  const files = Array.from(e.dataTransfer?.files || [])
  const images = files.filter(isImageFile)

  for (const img of images) {
    await uploadAndInsert(img, props.editorView)
  }
}

// Typed as `Event` so it matches the `EventListener` contract expected by
// add/removeEventListener without a cast. We narrow with `instanceof` inside.
async function handlePaste(e: Event) {
  if (!(e instanceof ClipboardEvent)) return
  if (props.readOnly || !props.editorView) return

  const items = Array.from(e.clipboardData?.items || [])
  const imageItems = items.filter(item => item.type.startsWith('image/'))

  if (imageItems.length === 0) return

  e.preventDefault()
  for (const item of imageItems) {
    const file = item.getAsFile()
    if (file) {
      await uploadAndInsert(file, props.editorView)
    }
  }
}

onMounted(() => {
  containerRef.value?.addEventListener('paste', handlePaste)
})

onUnmounted(() => {
  containerRef.value?.removeEventListener('paste', handlePaste)
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <slot />

    <!-- Drag overlay -->
    <Transition name="fade">
      <div
        v-if="dragging && !readOnly"
        class="absolute inset-0 z-20 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg pointer-events-none"
      >
        <div class="text-center">
          <UIcon name="i-lucide-image-plus" class="size-10 text-primary mb-2" />
          <p class="text-sm font-medium text-primary">{{ t('image.dropToUpload') }}</p>
        </div>
      </div>
    </Transition>

    <!-- Upload indicator -->
    <div
      v-if="uploading"
      class="absolute top-2 right-2 z-20 flex items-center gap-2 bg-[var(--ui-bg)] border border-default rounded-lg px-3 py-1.5 shadow-lg"
    >
      <UIcon name="i-lucide-loader" class="size-4 animate-spin text-primary" />
      <span class="text-xs">{{ t('image.uploading') }}</span>
    </div>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
