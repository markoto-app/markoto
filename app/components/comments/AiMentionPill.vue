<script setup lang="ts">
// `@ai` chip rendered inside comment bodies. Visually distinct from
// the regular @user mention pill — uses a violet/blue gradient so the
// reader can tell at a glance that the comment will summon the AI.
//
// Sibling to `MentionPill.vue`; kept separate so the user-mention
// styles don't have to branch on a "kind" prop and so the AI badge
// can carry its own affordances later (tooltip explaining the trigger,
// etc.) without complicating the user-mention path.

const { t } = useI18n()
</script>

<template>
  <UTooltip :text="t('comments.aiMentionTooltip')">
    <span
      class="ai-mention-pill inline-flex items-center gap-0.5 rounded px-1 py-px text-xs font-semibold align-baseline"
      data-testid="comment-ai-mention"
    >
      <UIcon
        name="i-lucide-sparkles"
        class="size-3"
      />
      <span>ai</span>
    </span>
  </UTooltip>
</template>

<style scoped>
.ai-mention-pill {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-violet-500, #8b5cf6) 20%, transparent),
    color-mix(in srgb, var(--color-blue-500, #3b82f6) 20%, transparent)
  );
  color: var(--color-violet-700, #6d28d9);
}
.dark .ai-mention-pill {
  color: var(--color-violet-300, #c4b5fd);
}
</style>
