<script setup lang="ts">
/**
 * The AI thinking line, the italic-serif moment.
 *
 * This is the ONE place in the product where Fraunces italic appears.
 * The brain learns: italic serif equals AI is talking *about* the
 * document rather than editing it. If italic-serif shows up in a button
 * or a heading, the meaning evaporates. Used here, the restraint is
 * the whole point.
 *
 * The seal sits to the left of the text at 6×6px, a small visual
 * anchor that ties the thinking line back to the brand mark. The
 * component animates in with a fade + 8px translate (240ms ease-out,
 * keyframe defined in main.css).
 */
defineProps<{
  /** The reflective AI line, short, observational, never anthropomorphized. */
  text: string
}>()
</script>

<template>
  <p class="mk-ai-thinking">
    <span
      class="mk-ai-thinking__seal"
      aria-hidden="true"
    />
    <span class="mk-ai-thinking__text">{{ text }}</span>
  </p>
</template>

<style scoped>
.mk-ai-thinking {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  line-height: 1.55;
  color: var(--color-sumi-500);
  margin: 0;
  animation: mk-ai-thinking-enter 240ms cubic-bezier(0.2, 0, 0, 1) both;
}
html.dark .mk-ai-thinking {
  color: var(--color-sumi-400);
}
.mk-ai-thinking__seal {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--color-shu-500);
  border-radius: 1px;
  flex-shrink: 0;
  /* Pull the seal up off the baseline so it visually centers against
     the x-height of the italic-serif body, rather than sitting at the
     descender. */
  transform: translateY(-2px);
}
html.dark .mk-ai-thinking__seal {
  background: var(--color-shu-400);
}
</style>
