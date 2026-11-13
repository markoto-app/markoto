<script setup lang="ts">
import TableSizePicker from '../TableSizePicker.vue'

// Table size dialog, opened from the menu's Insert → Table and the toolbar's
// Table button.
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ select: [size: { rows: number, cols: number }] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('table.title')"
    :description="t('table.description')"
    :ui="{ content: 'max-w-fit' }"
  >
    <template #body>
      <TableSizePicker @select="size => emit('select', size)" />
    </template>
  </UModal>
</template>
