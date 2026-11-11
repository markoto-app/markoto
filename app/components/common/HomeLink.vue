<script setup lang="ts">
// Top-left home link for subpages (pricing, profile, legal/*, admin/*);
// pairs with the close button on the right.

interface Props {
  /** Wordmark height in px. Defaults to 20 — slightly larger
      than the topbar's 18px because subpage chrome has more
      breathing room. */
  size?: number
}
withDefaults(defineProps<Props>(), { size: 20 })
</script>

<template>
  <NuxtLink
    to="/"
    class="absolute top-4 left-4 z-10 inline-flex items-center gap-2.5 hover:opacity-80 transition-opacity"
    aria-label="markoto — home"
    data-testid="page-home-link"
  >
    <CommonWordmark :size="size" />
    <CommonInstanceBrand :size="size" />
  </NuxtLink>
</template>
