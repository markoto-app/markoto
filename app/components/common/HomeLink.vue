<script setup lang="ts">
// Top-left home link for subpages (pricing, profile, legal/*,
// admin/*). Mirrors the close-button (top-right) — every modal-
// style page now has a logo back-to-home on the left and an X
// on the right. Visual symmetry + a clear escape route either way.

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
    class="absolute top-4 left-4 z-10 hover:opacity-80 transition-opacity"
    aria-label="markoto — home"
    data-testid="page-home-link"
  >
    <CommonWordmark :size="size" />
  </NuxtLink>
</template>
