<script setup lang="ts">
import CommentThread from '~/components/comments/CommentThread.vue'
import CommentComposer from '~/components/comments/CommentComposer.vue'
import type { DerivedSuggestion } from '~/composables/suggestions/useSuggestions'
import type { DerivedComment } from '~/composables/comments/useComments'
import { REPLY_BODY_MAX } from '~/utils/comments/commentBody'

// One suggestion's margin card: who proposed what and when, accept /
// reject (people who edit directly), withdraw (the author), and the reply
// thread, a comment thread tied to the suggestion.

const props = defineProps<{
  suggestion: DerivedSuggestion
  /** May accept and reject (edits directly). */
  canReview: boolean
  /** May write replies (not read-only). */
  canReply: boolean
  thread: DerivedComment | null
  focused: boolean
  busy: boolean
  viewerId: number | null
  viewerName: string
}>()

const emit = defineEmits<{
  'focus': [id: string]
  'accept': [id: string]
  'reject': [id: string]
  'withdraw': [id: string]
  'reply': [suggestionId: string, body: string]
  'reply-thread': [threadId: string, body: string]
  'delete-reply': [threadId: string, replyId: string]
}>()

const { t } = useI18n()

const avatarSeed = computed(() => avatarSeedFor({ id: props.suggestion.authorId, avatarSeed: props.suggestion.authorAvatarSeed, fallback: props.suggestion.authorName }))
const relativeTime = useRelativeTime(() => new Date(props.suggestion.updatedAt))
const authorLabel = computed(() => props.suggestion.isAi ? t('suggestions.aiAuthor') : props.suggestion.authorName)

const kindLabel = computed(() => {
  if (props.suggestion.obsolete) return t('suggestions.kind.obsolete')
  return t(`suggestions.kind.${props.suggestion.kind}`)
})

/** Long passages are shortened on the card; the editor shows them in full. */
function clip(text: string): string {
  return text.length > 280 ? `${text.slice(0, 279)}…` : text
}

const replying = ref(false)
const replyKey = ref(0)
function submitReply(body: string) {
  if (props.thread) emit('reply-thread', props.thread.id, body)
  else emit('reply', props.suggestion.id, body)
  replying.value = false
  replyKey.value++
}
</script>

<template>
  <div
    class="rounded-md border bg-default p-3 space-y-2"
    :class="focused ? 'border-default ring-1 ring-[var(--suggest-color)]' : 'border-default/60'"
    :style="{ '--suggest-color': suggestion.color }"
    :data-suggestion-card="suggestion.id"
    data-testid="suggestion-card"
    @click="emit('focus', suggestion.id)"
  >
    <div class="flex items-center gap-2">
      <div
        v-if="suggestion.isAi"
        class="size-6 shrink-0 rounded-full flex items-center justify-center bg-default border border-default"
      >
        <CommonSeal :size="8" />
      </div>
      <CommonUserAvatar
        v-else
        :seed="avatarSeed"
        :size="24"
      />
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 text-xs">
          <span
            class="font-medium text-default truncate"
            data-testid="suggestion-author"
          >{{ authorLabel }}</span>
          <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted shrink-0 lowercase">{{ relativeTime }}</span>
        </div>
        <span class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">{{ kindLabel }}</span>
      </div>
      <div
        class="flex items-center gap-0.5 shrink-0"
        @click.stop
      >
        <template v-if="canReview">
          <UTooltip :text="t('suggestions.accept')">
            <UButton
              icon="i-lucide-check"
              color="success"
              variant="ghost"
              size="sm"
              :loading="busy"
              :aria-label="t('suggestions.accept')"
              data-testid="suggestion-accept"
              @click="emit('accept', suggestion.id)"
            />
          </UTooltip>
          <UTooltip :text="t('suggestions.reject')">
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="busy"
              :aria-label="t('suggestions.reject')"
              data-testid="suggestion-reject"
              @click="emit('reject', suggestion.id)"
            />
          </UTooltip>
        </template>
        <UTooltip
          v-else-if="suggestion.mine"
          :text="t('suggestions.withdraw')"
        >
          <UButton
            icon="i-lucide-undo-2"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="t('suggestions.withdraw')"
            data-testid="suggestion-withdraw"
            @click="emit('withdraw', suggestion.id)"
          />
        </UTooltip>
      </div>
    </div>

    <div class="text-sm break-words whitespace-pre-wrap leading-relaxed">
      <span
        v-if="suggestion.current || suggestion.deleted"
        class="suggest-card-del"
        data-testid="suggestion-deleted-text"
      >{{ clip(suggestion.current || suggestion.deleted) }}</span>
      <span
        v-if="suggestion.text"
        class="suggest-card-ins"
        data-testid="suggestion-inserted-text"
      >{{ clip(suggestion.text) }}</span>
    </div>

    <p
      v-if="suggestion.obsolete"
      class="text-xs text-muted"
    >
      {{ t('suggestions.obsoleteHint') }}
    </p>
    <p
      v-else-if="suggestion.changed && suggestion.kind !== 'insert'"
      class="text-xs text-muted"
    >
      {{ t('suggestions.changedHint') }}
    </p>

    <div @click.stop>
      <CommentThread
        v-if="thread"
        :comment="thread"
        :read-only="!canReply"
        :viewer-id="viewerId"
        :viewer-name="viewerName"
        @reply="(id, body) => emit('reply-thread', id, body)"
        @delete-reply="(id, replyId) => emit('delete-reply', id, replyId)"
      />
      <template v-else-if="canReply">
        <CommentComposer
          v-if="replying"
          :key="replyKey"
          :auto-focus="true"
          :max-length="REPLY_BODY_MAX"
          :mentionable-users="[]"
          :placeholder="t('suggestions.replyPlaceholder')"
          :submit-label="t('comments.reply')"
          @submit="submitReply"
          @cancel="replying = false"
        />
        <UButton
          v-else
          icon="i-lucide-reply"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          data-testid="suggestion-reply"
          @click="replying = true"
        >
          {{ t('comments.reply') }}
        </UButton>
      </template>
    </div>
  </div>
</template>

<style scoped>
.suggest-card-del {
  text-decoration: line-through;
  text-decoration-color: var(--suggest-color);
  color: var(--ui-text-muted);
}

.suggest-card-ins {
  text-decoration: underline;
  text-decoration-color: var(--suggest-color);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  margin-left: 0.25rem;
}
</style>
