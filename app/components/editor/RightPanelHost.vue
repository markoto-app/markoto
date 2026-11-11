<script setup lang="ts">
/**
 * Wrapper for the editor's right-sidebar panels (theme, comments, activity,
 * document, knowledge). Renders the same slot content in two shapes:
 *
 *   - Mobile (<sm)   inside `<BottomSheet>` (drag handle, slide-up, preview stays visible above)
 *   - Desktop (>=sm) inside the `<aside>` (fixed sidebar at xl+, flex-1 column below)
 *
 * Lets EditorLayout keep one panel-render block. The host owns the chrome;
 * the caller fills in the panel content.
 */
import { useMediaQuery } from '@vueuse/core'
import BottomSheet from '~/components/common/BottomSheet.vue'

const props = defineProps<{
  /** Truthy when any right panel is selected. */
  open: boolean
  /** Desktop sidebar width class: edit -> `w-full sm:w-80 sm:shrink-0`;
   *  split/preview -> `flex-1 min-w-0 xl:flex-none xl:w-80 xl:shrink-0`. */
  viewMode: 'edit' | 'split' | 'preview'
}>()

const emit = defineEmits<{
  close: []
}>()

const isMobile = useMediaQuery('(max-width: 639px)')

function onSheetUpdate(v: boolean) {
  if (!v) emit('close')
}
</script>

<template>
  <!-- Mobile: bottom sheet bound to `open`; its update:modelValue=false is
       forwarded to `close`. No `title` prop on purpose: every panel brings its
       own header (icon + title + × close), and a second header duplicated the
       title and wasted ~48px of viewport. The drag handle still comes from BottomSheet. -->
  <BottomSheet
    v-if="isMobile"
    :model-value="open"
    @update:model-value="onSheetUpdate"
  >
    <slot />
  </BottomSheet>

  <!-- Desktop: fixed sidebar layout. -->
  <aside
    v-else-if="open"
    :class="[
      props.viewMode === 'edit'
        ? 'w-full sm:w-80 sm:shrink-0'
        : 'flex-1 min-w-0 xl:flex-none xl:w-80 xl:shrink-0'
    ]"
    class="border-l border-default h-full overflow-hidden"
  >
    <slot />
  </aside>
</template>
