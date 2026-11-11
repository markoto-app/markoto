<script setup lang="ts">
// The customer's mark on a managed private instance: their logo
// and name after the markoto wordmark, behind a hairline. Renders nothing
// unless the operator configured a brand (NUXT_INSTANCE_BRAND_*).

withDefaults(defineProps<{
  /** Logo height in px — match the wordmark beside it. */
  size?: number
  /** Show the name (off where space is short; the logo's alt text carries it). */
  showName?: boolean
}>(), { size: 18, showName: true })

const { brand } = useInstanceConfig()
const visible = computed(() => brand.value.name !== '' || brand.value.logoUrl !== null)
</script>

<template>
  <span
    v-if="visible"
    class="inline-flex items-center gap-2.5 min-w-0"
    data-testid="instance-brand"
  >
    <span
      class="block w-px bg-sumi-300 dark:bg-sumi-700 shrink-0"
      :style="{ height: `${size}px` }"
      aria-hidden="true"
    />
    <img
      v-if="brand.logoUrl"
      :src="brand.logoUrl"
      :alt="brand.name"
      :style="{ height: `${size}px` }"
      class="w-auto max-w-[8rem] object-contain shrink-0"
    >
    <span
      v-if="showName && brand.name"
      class="font-serif text-sm tracking-tight text-muted truncate"
    >{{ brand.name }}</span>
  </span>
</template>
