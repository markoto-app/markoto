<script setup lang="ts">
// A theme colour: a swatch button that opens the colour picker.
defineProps<{
  /** `data-testid` of the swatch button. */
  testid?: string
}>()
const color = defineModel<string>({ required: true })
</script>

<template>
  <UPopover>
    <UButton
      color="neutral"
      variant="outline"
      class="w-full justify-start"
      :data-testid="testid"
    >
      <span
        class="size-4 rounded border border-default"
        :style="{ backgroundColor: color }"
      />
      <span class="font-mono text-xs">{{ color }}</span>
    </UButton>
    <template #content>
      <UColorPicker
        v-model="color"
        class="p-2"
      />
    </template>
  </UPopover>
</template>
