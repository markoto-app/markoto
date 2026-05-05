<script setup lang="ts">
/**
 * Branching wrapper for the editor's right-sidebar panels (theme,
 * comments, activity, document, knowledge). Renders the same slot
 * content in two shapes:
 *
 *   - Mobile (<sm)   → inside `<BottomSheet>` (drag handle, slide-up,
 *                      preserves preview visibility above)
 *   - Desktop (>=sm) → inside the existing `<aside>` (fixed sidebar at
 *                      xl+, flex-1 column at <xl)
 *
 * Lets EditorLayout keep ONE panel-render block (5 v-ifs) without
 * duplicating it for each layout. The host owns the chrome; the
 * caller fills in the panel content.
 */
import { useMediaQuery } from '@vueuse/core'
import BottomSheet from '~/components/common/BottomSheet.vue'

const props = defineProps<{
  /** Truthy when ANY right-panel is selected. */
  open: boolean
  /** Drives the desktop sidebar's width class:
   *   edit         → `w-full sm:w-80 sm:shrink-0`
   *   split/preview → `flex-1 min-w-0 xl:flex-none xl:w-80 xl:shrink-0` */
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
  <!-- Mobile: bottom-sheet wrapper. Open state binds to `open`; the
       sheet emits update:modelValue=false on dismiss → we forward
       to `close`. We deliberately DO NOT pass a `title` prop — every
       panel rendered inside this slot brings its own header (icon +
       title + × close button) so the user can both read the panel
       name and dismiss it. Letting BottomSheet render a second
       header on top duplicated the title and wasted ~48px of mobile
       viewport. The drag handle still ships from BottomSheet
       independently of the header. -->
  <BottomSheet
    v-if="isMobile"
    :model-value="open"
    @update:model-value="onSheetUpdate"
  >
    <slot />
  </BottomSheet>

  <!-- Desktop: existing fixed-sidebar layout. Same width classes the
       caller had inline before this component existed. -->
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
