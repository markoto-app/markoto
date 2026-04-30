<script setup lang="ts">
import CommentItem from '~/components/comments/CommentItem.vue'
import CommentComposer from '~/components/comments/CommentComposer.vue'
import { REPLY_BODY_MAX } from '~/utils/commentBody'
import type { DerivedComment } from '~/composables/useComments'

interface MentionableUser {
  id: number
  name: string
  email: string | null
  avatarUrl: string | null
}

const props = withDefaults(defineProps<{
  comment: DerivedComment
  /** Disable all mutating actions (read-only viewer / no edit access). */
  readOnly?: boolean
  /** Greyed out — applied for orphaned and resolved threads in the sidebar. */
  muted?: boolean
  mentionableUsers?: readonly MentionableUser[]
  /** Highlighted — applied when the user clicked the matching anchor in the doc. */
  focused?: boolean
  /**
   * True while an AI session is responding to this thread (triggered
   * by an @ai mention). Renders a rainbow-glow border similar to the
   * AI prompt bar's active state, plus a "AI is responding…" footer.
   */
  aiActive?: boolean
  /**
   * Identity of the local viewer. Drives "can delete" — authors can
   * delete their own comments. Anonymous (`null`) can delete only
   * their own anon comments (i.e. authorId is also null AND
   * authorName matches their session name).
   */
  viewerId?: number | null
  viewerName?: string
}>(), {
  readOnly: false,
  muted: false,
  mentionableUsers: () => [],
  focused: false,
  aiActive: false,
  viewerId: null,
  viewerName: ''
})

const emit = defineEmits<{
  /** User clicked the thread; parent should scroll editor to anchor. */
  'focus': [id: string]
  'delete-comment': [id: string]
  'resolve': [id: string]
  'unresolve': [id: string]
  'reply': [id: string, body: string]
  'delete-reply': [commentId: string, replyId: string]
}>()

/**
 * The local viewer can delete a given author's comment when:
 *  - logged-in: their userId matches authorId
 *  - anon-on-anon: both have authorId === null AND author display
 *    names match (best we can do without persistent identity)
 */
function canDelete(authorId: number | null, authorName: string): boolean {
  if (props.readOnly) return false
  if (props.viewerId !== null) return authorId === props.viewerId
  return authorId === null && props.viewerName.length > 0 && authorName === props.viewerName
}

const { t } = useI18n()

// Reply composer key — bumped after every successful submit to force the
// child to remount with an empty body. Avoids needing two-way binding.
const replyResetKey = ref(0)

function onSubmitReply(body: string) {
  emit('reply', props.comment.id, body)
  replyResetKey.value++
}

function onClickThread(e: MouseEvent) {
  // Don't fire `focus` when the click came from inside an interactive
  // child (button, textarea, link). That would steal focus from
  // composers and toggle buttons.
  const target = e.target as HTMLElement | null
  if (!target) return
  if (target.closest('button, textarea, input, a, [role="option"]')) return
  emit('focus', props.comment.id)
}
</script>

<template>
  <div
    class="comment-thread-card rounded-md border border-default bg-default p-3 cursor-pointer transition-shadow shadow-sm"
    :class="[
      muted ? 'opacity-70 hover:opacity-100' : '',
      focused && !aiActive ? 'ring-2 ring-primary-500/50 shadow-md' : (!aiActive ? 'hover:shadow-md hover:border-primary/40' : ''),
      aiActive ? 'is-ai-active' : ''
    ]"
    :data-comment-id="comment.id"
    :data-ai-active="aiActive ? 'true' : 'false'"
    data-testid="comment-thread"
    @click="onClickThread"
  >
    <p
      v-if="comment.anchor === null"
      class="text-[11px] text-muted italic mb-1.5"
    >
      {{ t('comments.orphanedHint') }}
    </p>

    <CommentItem
      :body="comment.body"
      :author-name="comment.authorName"
      :author-avatar="comment.authorAvatar"
      :created-at="comment.createdAt"
      :is-thread-root="true"
      :resolved="comment.resolved"
      :read-only="readOnly"
      :can-delete="canDelete(comment.authorId, comment.authorName)"
      @delete="emit('delete-comment', comment.id)"
      @resolve="emit('resolve', comment.id)"
      @unresolve="emit('unresolve', comment.id)"
    />

    <div
      v-if="comment.replies.length > 0"
      class="mt-4 pl-3 border-l border-default space-y-4"
    >
      <CommentItem
        v-for="reply in comment.replies"
        :key="reply.id"
        :body="reply.body"
        :author-name="reply.authorName"
        :author-avatar="reply.authorAvatar"
        :created-at="reply.createdAt"
        :read-only="readOnly"
        :can-delete="canDelete(reply.authorId, reply.authorName)"
        @delete="emit('delete-reply', comment.id, reply.id)"
      />
    </div>

    <!-- "markoto is responding" indicator. Seal anchor instead of
         the lucide sparkles icon — the seal is the brand's universal
         AI presence mark. -->
    <div
      v-if="aiActive"
      class="mt-2 flex items-center gap-2 text-xs ai-responding-row"
      data-testid="comment-ai-responding"
    >
      <CommonSeal :size="8" />
      <span class="ai-responding-label">{{ t('comments.aiResponding') }}</span>
    </div>

    <div
      v-if="!readOnly"
      class="mt-3"
    >
      <CommentComposer
        :key="replyResetKey"
        :placeholder="t('comments.replyPlaceholder')"
        :mentionable-users="mentionableUsers"
        :submit-label="t('comments.replyPost')"
        :hide-cancel="true"
        :max-length="REPLY_BODY_MAX"
        @submit="onSubmitReply"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * "markoto is responding" treatment — same single-color shu pulse
 * that lives on the AI prompt bar's active state. Earlier this card
 * cycled through the full rainbow which contradicted the brand rule
 * "shu means AI presence, nothing else". One color, one breathing
 * shadow — same vocabulary as every other AI surface in the product.
 */
@property --mk-thread-pulse {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}

@keyframes mk-thread-pulse {
  0%, 100% { --mk-thread-pulse: 0; }
  50%      { --mk-thread-pulse: 1; }
}

.comment-thread-card.is-ai-active {
  animation: mk-thread-pulse 2.4s ease-in-out infinite;
  --_p: var(--mk-thread-pulse);
  border-color: transparent;
  box-shadow:
    /* Border ring — thickness pulses 1.5px → 2.5px, color is locked shu */
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-500) calc(60% + var(--_p) * 25%), transparent),
    /* Outer glow — opacity + blur breathe */
    0 calc(8px + var(--_p) * 8px) calc(20px + var(--_p) * 14px) -8px color-mix(in srgb, var(--color-shu-500) calc(28% + var(--_p) * 22%), transparent);
}

:global(.dark) .comment-thread-card.is-ai-active {
  box-shadow:
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-400) calc(65% + var(--_p) * 25%), transparent),
    0 calc(8px + var(--_p) * 8px) calc(20px + var(--_p) * 14px) -8px color-mix(in srgb, var(--color-shu-400) calc(32% + var(--_p) * 24%), transparent);
}

@media (prefers-reduced-motion: reduce) {
  .comment-thread-card.is-ai-active {
    animation: none;
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--color-shu-500) 75%, transparent),
      0 8px 24px -8px color-mix(in srgb, var(--color-shu-500) 35%, transparent);
  }
}

/* Footer "markoto is responding…" label only — pulse opacity gently so
   it reads as "still working" even at a glance. The icon next to it
   is the brand seal (rendered via <CommonSeal>), which already carries
   the shu cue without needing CSS color. */
@keyframes mk-thread-label-pulse {
  0%, 100% { opacity: 0.65; }
  50%      { opacity: 1; }
}

.is-ai-active .ai-responding-label {
  animation: mk-thread-label-pulse 2.4s ease-in-out infinite;
  font-weight: 500;
}
</style>
