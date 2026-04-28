<script setup lang="ts">
import MentionPill from '~/components/comments/MentionPill.vue'
import AiMentionPill from '~/components/comments/AiMentionPill.vue'
import { parseCommentBody } from '~/utils/commentBody'

const props = withDefaults(defineProps<{
  body: string
  authorName: string
  authorAvatar: string | null
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

const segments = computed(() => parseCommentBody(props.body))

// Live "X ago" string via `useTimeAgoIntl` — owns its own 30s ticker
// and uses Intl.RelativeTimeFormat for locale-aware output ("5 minutes
// ago" / "vor 5 Minuten" / etc.) without per-locale i18n keys.
const relativeTime = useTimeAgoIntl(() => new Date(props.createdAt))
</script>

<template>
  <div class="flex gap-2">
    <UAvatar
      :src="authorAvatar ?? undefined"
      :alt="authorName"
      size="xs"
      class="shrink-0 mt-0.5"
      referrerpolicy="no-referrer"
    />
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2 text-xs">
        <span class="font-semibold text-default truncate">{{ authorName }}</span>
        <span class="text-muted shrink-0">{{ relativeTime }}</span>
      </div>

      <div class="mt-0.5 text-sm text-default whitespace-pre-wrap break-words">
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

      <div
        v-if="!readOnly && (canDelete || isThreadRoot)"
        class="mt-1.5 flex items-center gap-2 text-xs"
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
          class="text-muted"
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
