<script setup lang="ts">
/**
 * The AI tag — the cursor companion. A small inline pill with the AI's
 * name. Shu background, sumi-50 text in BOTH light and dark mode (the
 * white-on-red gives the tag the "hot stamp" feel that the brand calls
 * for). Sized for trailing-the-cursor in awareness UI.
 *
 * When more than one AI agent eventually inhabits the doc, every agent
 * gets its own shu tag with its name. They all share the seal red —
 * collaborator humans get cool slate names, AIs get shu. The two never
 * mix.
 */
withDefaults(defineProps<{
  /** Display name. Defaults to "AI" — keep it short, this is a tag. */
  name?: string
}>(), {
  name: 'AI'
})
</script>

<template>
  <span class="mk-ai-tag">{{ name }}</span>
</template>

<style scoped>
.mk-ai-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 2px;
  background: var(--color-shu-500);
  color: var(--color-sumi-50);
  letter-spacing: 0.02em;
  vertical-align: middle;
}
html.dark .mk-ai-tag {
  background: var(--color-shu-400);
  color: var(--color-sumi-50);
}
</style>
