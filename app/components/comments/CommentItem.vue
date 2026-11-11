<script setup lang="ts">
import MentionPill from '~/components/comments/MentionPill.vue'
import AiMentionPill from '~/components/comments/AiMentionPill.vue'
import { parseCommentBody } from '~/utils/comments/commentBody'
import { isAiCommentAuthor } from '~~/shared/ai/author'

const props = withDefaults(defineProps<{
  body: string
  authorName: string
  authorId: number | null
  /** Anonymous author's avatar token (see `useComments`). */
  authorAvatarSeed: string | null
  createdAt: number
  /** Show "Resolve" action; only on the thread root (not on replies). */
  isThreadRoot?: boolean
  resolved?: boolean
  /** Hide all action buttons (read-only viewers + non-author cells). */
  readOnly?: boolean
  /** Show the Delete action. Authors of the comment, plus admins, get this. */
  canDelete?: boolean
}>(), {
  isThreadRoot: false,
  resolved: false,
  readOnly: false,
  canDelete: false
})

const emit = defineEmits<{
  delete: []
  resolve: []
  unresolve: []
}>()

const { t } = useI18n()

// The AI keeps its seal disc; people get their generated face.
const isAi = computed(() => isAiCommentAuthor(props.authorId, props.authorName))
const avatarSeed = computed(() => avatarSeedFor({ id: props.authorId, avatarSeed: props.authorAvatarSeed, fallback: props.authorName }))

const segments = computed(() => parseCommentBody(props.body))

// Live "X ago" string via `useTimeAgoIntl` — owns its own 30s ticker
// and uses Intl.RelativeTimeFormat for locale-aware output ("5 minutes
// ago" / "vor 5 Minuten" / etc.) without per-locale i18n keys.
const relativeTime = useTimeAgoIntl(() => new Date(props.createdAt))
</script>

<template>
  <div
    class="flex gap-2"
    data-testid="comment-item"
  >
    <div
      v-if="isAi"
      class="size-6 shrink-0 mt-0.5 rounded-full flex items-center justify-center bg-default border border-default"
    >
      <CommonSeal :size="8" />
    </div>
    <CommonUserAvatar
      v-else
      :seed="avatarSeed"
      :size="24"
      class="mt-0.5"
    />
    <div class="flex-1 min-w-0">
      <!-- Author + timestamp register: author in Inter weight 500
           (no bold — the brand stays at 400/500 max), timestamp in
           JetBrains Mono with the mockup's 0.04em tracking, lower
           opacity to feel like a slate caption beside the author. -->
      <div class="flex items-baseline gap-2 text-xs">
        <span class="font-medium text-default truncate">{{ authorName }}</span>
        <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted shrink-0 lowercase">{{ relativeTime }}</span>
      </div>

      <div class="mt-1 text-sm text-default whitespace-pre-wrap break-words">
        <template
          v-for="(seg, i) in segments"
          :key="i"
        >
          <MentionPill
            v-if="seg.kind === 'mention'"
            :user-id="seg.userId"
            :name="seg.name"
          />
          <AiMentionPill v-else-if="seg.kind === 'ai-mention'" />
          <template v-else>
            {{ seg.text }}
          </template>
        </template>
      </div>

      <!-- Action row in the mockup's mono micro-label register. Same
           10.5px / 0.04em pattern as the status bar so the whole UI
           reads with one consistent "instrument" voice. The middot
           sits at lowered opacity as a hairline divider. -->
      <div
        v-if="!readOnly && (canDelete || isThreadRoot)"
        class="mt-2 flex items-center gap-2 font-mono text-[10.5px] tracking-[0.04em] lowercase"
      >
        <button
          v-if="canDelete"
          class="text-muted hover:text-error transition-colors"
          data-testid="comment-action-delete"
          @click.stop="emit('delete')"
        >
          {{ t('comments.delete') }}
        </button>
        <span
          v-if="canDelete && isThreadRoot"
          class="text-muted opacity-50"
          aria-hidden="true"
        >·</span>
        <template v-if="isThreadRoot">
          <button
            v-if="!resolved"
            class="text-muted hover:text-default transition-colors"
            data-testid="comment-action-resolve"
            @click.stop="emit('resolve')"
          >
            {{ t('comments.resolve') }}
          </button>
          <button
            v-else
            class="text-muted hover:text-default transition-colors"
            data-testid="comment-action-unresolve"
            @click.stop="emit('unresolve')"
          >
            {{ t('comments.unresolve') }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
