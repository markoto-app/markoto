<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Footer: the running footer's slots.
const emit = defineEmits<{
  'slot-focus': [input: HTMLInputElement]
  'insert-token': [token: string]
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
</script>

<template>
  <div class="space-y-3 pt-2 pb-4">
    <DocumentThemeRunningSlotFields
      v-model:theme="theme"
      part="footer"
      @slot-focus="el => emit('slot-focus', el)"
      @insert-token="token => emit('insert-token', token)"
    />
  </div>
</template>
