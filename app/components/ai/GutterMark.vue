<script setup lang="ts">
/**
 * The AI gutter mark — authorship trace. A 5×5px shu square that sits
 * in the left gutter of any block authored by the AI. Persists after
 * the AI is gone, marking provenance.
 *
 * When the human accepts the AI's edit (or rewrites it heavily), the
 * mark fades to sumi-300, holds briefly, then disappears entirely. This
 * is the visual language for "authorship merges back into the human's
 * hands" — the keyframe is defined in main.css as `mk-gutter-mark-merge`.
 *
 * Drive the merge animation by setting `merging` to true on accept.
 * Once the animation completes, unmount the component (the parent
 * decides — we don't auto-remove, since "accepted" is a domain event).
 */
withDefaults(defineProps<{
  /** Run the fade-to-sumi-then-out animation. */
  merging?: boolean
}>(), {
  merging: false
})
</script>

<template>
  <span
    class="mk-gutter-mark"
    :class="{ 'mk-gutter-mark--merging': merging }"
    aria-hidden="true"
  />
</template>

<style scoped>
.mk-gutter-mark {
  position: absolute;
  left: -22px;
  top: 9px;
  width: 5px;
  height: 5px;
  background: var(--color-shu-500);
  /* Square. Authorship marks are not rounded — they're stamps. */
}
html.dark .mk-gutter-mark {
  background: var(--color-shu-400);
}
.mk-gutter-mark--merging {
  animation: mk-gutter-mark-merge 1000ms ease-out forwards;
}
</style>
