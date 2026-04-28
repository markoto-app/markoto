<script setup lang="ts">
/**
 * The AI cursor. A 2px-wide vertical bar in shu, height of one body
 * line, blinking at 1s steps(2). Sits inline within the line the AI
 * is editing.
 *
 * Brand rule: shu is reserved for AI presence. A real human collaborator's
 * cursor renders in the cool slate `info` ramp; the two never share a
 * color. This component takes no `color` prop — it is always shu.
 *
 * Today this primitive is a brand-aligned drop-in for places where the
 * AI's edit position is rendered outside CodeMirror's own decoration
 * pipeline (status bars, awareness dots, AI-side comment threads). The
 * in-document yCollab cursor lives in the editor theme.
 */
</script>

<template>
  <span
    class="mk-ai-cursor"
    aria-hidden="true"
  />
</template>

<style scoped>
.mk-ai-cursor {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  background: var(--color-shu-500);
  vertical-align: -3px;
  margin-left: 1px;
  animation: mk-ai-cursor-blink 1s steps(2) infinite;
}
:global(.dark) .mk-ai-cursor {
  background: var(--color-shu-400);
}
</style>
