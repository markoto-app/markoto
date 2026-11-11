<script setup lang="ts">
// `@markoto` chip in comment bodies. The leading shu seal is the AI presence
// mark shared by every AI surface. Kept separate from `MentionPill.vue` so
// user mentions don't branch on a "kind" prop.

const { t } = useI18n()
</script>

<template>
  <UTooltip :text="t('comments.aiMentionTooltip')">
    <span
      class="mk-mention-pill inline-flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium align-baseline"
      data-testid="comment-ai-mention"
    >
      <CommonSeal :size="8" />
      <span>markoto</span>
    </span>
  </UTooltip>
</template>

<style scoped>
.mk-mention-pill {
  /* Subtle shu wash gives the chip body; text stays sumi so it doesn't shout. */
  background: color-mix(in srgb, var(--color-shu-500) 10%, transparent);
  color: var(--color-sumi-950);
}
.dark .mk-mention-pill {
  background: color-mix(in srgb, var(--color-shu-400) 12%, transparent);
  color: var(--color-sumi-50);
}
</style>
