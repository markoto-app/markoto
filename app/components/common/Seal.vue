<script setup lang="ts">
/**
 * The Markoto seal. A small filled vermillion (shu) square — modeled
 * on a hanko stamp on rice paper. Square, 2px corner radius, never
 * round, never gradient, never outlined. The seal is the brand mark
 * AND the in-product AI presence indicator. Default size is calibrated
 * for the wordmark lockup; downstream callers can override via the
 * `size` prop or by setting CSS `width`/`height` directly.
 *
 * The seal is rendered as a CSS shape (a span with background) rather
 * than an SVG/icon so it scales crisply, animates without an SVG hop,
 * and survives at favicon sizes (16px) without becoming a smudge.
 */
withDefaults(defineProps<{
  /** Seal edge length in pixels. */
  size?: number
}>(), {
  size: 14
})
</script>

<template>
  <span
    class="mk-seal"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  />
</template>

<style scoped>
.mk-seal {
  display: inline-block;
  background: var(--color-shu-500);
  border-radius: 2px;
  flex-shrink: 0;
}
html.dark .mk-seal {
  background: var(--color-shu-400);
}
</style>
