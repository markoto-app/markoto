<script setup lang="ts">
// `@markoto` chip rendered inside comment bodies. The leading shu
// seal is the universal mark of "intelligence is here" — same
// visual the AI prompt bar, AI workspace card, AI gutter mark, and
// AI authorship trace all use. The pill text is "markoto" (not "ai")
// because the brand voice never says "AI" or "assistant" — there's
// only one assistant in this product, and it's named markoto.
//
// Sibling to `MentionPill.vue`; kept separate so the user-mention
// styles don't have to branch on a "kind" prop and so the markoto
// badge can carry its own affordances later (tooltip explaining the
// trigger, etc.) without complicating the user-mention path.

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
  /* Subtle shu wash — the seal carries the AI cue, the wash gives
     the chip enough body to read as a pill rather than inline text.
     Color stays sumi-default so the pill doesn't shout. */
  background: color-mix(in srgb, var(--color-shu-500) 10%, transparent);
  color: var(--color-sumi-950);
}
.dark .mk-mention-pill {
  background: color-mix(in srgb, var(--color-shu-400) 12%, transparent);
  color: var(--color-sumi-50);
}
</style>
