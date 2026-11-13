<script setup lang="ts">
// A theme font picker: every item shown in its own face (the panel links
// the font stylesheets). Section headers are `type: 'label'` items.
defineProps<{
  items: Array<{ type?: 'label', label: string, value: string }>
}>()
const font = defineModel<string>({ required: true })
</script>

<template>
  <USelectMenu
    v-model="font"
    :items="items"
    value-key="value"
    class="w-full"
  >
    <template #item-label="{ item }">
      <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
    </template>
  </USelectMenu>
</template>
