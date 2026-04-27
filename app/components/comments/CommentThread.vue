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
    class="rounded-md border border-default bg-default p-3 cursor-pointer transition-shadow shadow-sm"
    :class="[
      muted ? 'opacity-70 hover:opacity-100' : '',
      focused ? 'ring-2 ring-primary-500/50 shadow-md' : 'hover:shadow-md hover:border-primary/40'
    ]"
    :data-comment-id="comment.id"
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
