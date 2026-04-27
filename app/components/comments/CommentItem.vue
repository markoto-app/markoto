<script setup lang="ts">
import MentionPill from '~/components/comments/MentionPill.vue'
import { parseCommentBody, formatRelativeTime } from '~/utils/commentBody'

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
  /**
   * Reactive "now" reference (ms epoch) used to keep the relative
   * timestamp ticking — the parent panel updates this on a 30s timer
   * so "just now" → "1m ago" without a page refresh.
   */
  now?: number
}>(), {
  isThreadRoot: false,
  resolved: false,
  readOnly: false,
  canDelete: false,
  now: () => Date.now()
})

const emit = defineEmits<{
  delete: []
  resolve: []
  unresolve: []
}>()

const { t } = useI18n()

const segments = computed(() => parseCommentBody(props.body))

// Recomputes whenever `props.now` ticks, so the panel's 30s timer
// surfaces "1m ago" → "2m ago" automatically.
const relativeTime = computed(() => formatRelativeTime(props.createdAt, t, props.now))
</script>

<template>
  <div class="flex gap-2">
    <UAvatar
      :src="authorAvatar ?? undefined"
      :alt="authorName"
      size="xs"
      class="shrink-0 mt-0.5"
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
            @click.stop="emit('resolve')"
          >
            {{ t('comments.resolve') }}
          </button>
          <button
            v-else
            class="text-muted hover:text-default transition-colors"
            @click.stop="emit('unresolve')"
          >
            {{ t('comments.unresolve') }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
