<script setup lang="ts">
import type { Text as YText } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { EditorView } from '@codemirror/view'
import CommentThread from '~/components/comments/CommentThread.vue'
import CommentComposer from '~/components/comments/CommentComposer.vue'
import { useCommentsContext } from '~/composables/useComments'
import { serializeAnchor, type SerializedAnchor } from '~/utils/commentAnchors'

interface MentionableUser {
  id: number
  name: string
  email: string | null
  avatarUrl: string | null
}

const props = defineProps<{
  ytext: YText
  awareness: Awareness
  view: EditorView | null
  docId: string
  docWorkspaceId: string | null
  /**
   * Read-only viewers can browse threads but can't author or mutate.
   * Mirror of `isReadOnly` from the parent.
   */
  readOnly: boolean
}>()

const emit = defineEmits<{
  /** User clicked a thread or just posted a draft → scroll editor to that anchor. */
  focus: [id: string]
  close: []
}>()

const { t } = useI18n()
const toast = useToast()

const {
  comments,
  createComment,
  deleteComment,
  setResolved,
  postReply,
  deleteReply
} = useCommentsContext()

// Local viewer identity, used by CommentThread to gate the Delete
// action (authors can delete their own; everyone else can resolve but
// not delete). Refreshed when awareness updates.
const viewerId = ref<number | null>(null)
const viewerName = ref('')
function refreshViewer() {
  const u = props.awareness.getLocalState()?.user as { id?: number, name?: string } | undefined
  viewerId.value = typeof u?.id === 'number' ? u.id : null
  viewerName.value = typeof u?.name === 'string' ? u.name : ''
}
refreshViewer()
props.awareness.on('change', refreshViewer)
onUnmounted(() => props.awareness.off('change', refreshViewer))

// CommentItem owns its own live-time ticker via useTimeAgoIntl —
// no need for a panel-level `now` ref piped down as props.

// Active = has an anchor AND not resolved. Orphaned = no anchor.
// Resolved = explicitly resolved (anchor irrelevant for grouping).
const activeComments = computed(() => comments.value.filter(c => c.anchor !== null && !c.resolved))
const orphanedComments = computed(() => comments.value.filter(c => c.anchor === null && !c.resolved))
const resolvedComments = computed(() => comments.value.filter(c => c.resolved))

const showResolved = ref(false)

// — Mentionable users (typeahead source) ─────────────────────────────
//
// Only fetch for workspace docs the viewer is a member of (matches the
// server-side gate). Standalone or non-member docs get an empty list,
// which the composer handles by simply not showing the popover.
const mentionableUsers = ref<MentionableUser[]>([])

onMounted(async () => {
  if (!props.docWorkspaceId) return
  try {
    const data = await $fetch<{ users: MentionableUser[] }>(`/api/docs/${props.docId}/mentionable-users`)
    mentionableUsers.value = data.users
  } catch {
    // Quietly degrade — the composer still works without typeahead.
  }
})

// — Draft state ──────────────────────────────────────────────────────
//
// The toolbar / menu / keyboard route here when the user requests a
// new comment. We hold the anchor locally until they post — no Y.js
// write happens until the composer's submit fires.
const draftAnchor = ref<SerializedAnchor | null>(null)
const focusedCommentId = ref<string | null>(null)
// Highlight fade — clears `focusedCommentId` 1.2s after a thread is
// focused so the visual highlight doesn't linger forever. Restarting
// (calling `start()` again) cancels the in-flight timer.
const focusFade = useTimeoutFn(() => {
  focusedCommentId.value = null
}, 1200, { immediate: false })

function startDraft(): boolean {
  if (props.readOnly) return false
  if (!props.view) return false
  const anchor = serializeAnchor(props.view, props.ytext)
  if (!anchor) {
    toast.add({
      title: t('comments.selectTextFirst'),
      icon: 'i-lucide-info',
      color: 'info'
    })
    return false
  }
  draftAnchor.value = anchor
  // Surface the panel into a known scroll position — top, where the
  // draft renders.
  nextTick(() => {
    scrollContainer.value?.scrollTo({ top: 0, behavior: 'smooth' })
  })
  return true
}

function cancelDraft() {
  draftAnchor.value = null
}

function submitDraft(body: string) {
  if (!draftAnchor.value) return
  const id = createComment(draftAnchor.value, body)
  draftAnchor.value = null
  highlight(id)
  emit('focus', id)
}

// — Click-to-focus a thread ──────────────────────────────────────────
function onThreadFocus(id: string) {
  highlight(id)
  emit('focus', id)
}

function highlight(id: string) {
  focusedCommentId.value = id
  // Restart the fade timer — calling start() while pending cancels
  // the in-flight callback and reschedules.
  focusFade.start()
}

// Parent (EditorLayout) calls `focusComment(id)` when the editor emits
// `comment:focus` — e.g. user clicked the underline in the doc and the
// sidebar should highlight + scroll the matching thread.
function focusComment(id: string) {
  const el = document.querySelector(`[data-comment-id="${id}"]`)
  if (el && 'scrollIntoView' in el) {
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  highlight(id)
}

defineExpose({ startDraft, focusComment })

// Thread row factored as a reusable in-template fragment — three
// sections (active / orphaned / resolved) used to render the same
// `<CommentThread>` block with near-identical bindings; the only
// per-section differences are the data source and the `muted` flag.
// The `comment` + `muted` slot props parameterise the reuse.
const [DefineThreadRow, ReuseThreadRow] = createReusableTemplate<{
  comment: import('~/composables/useComments').DerivedComment
  muted?: boolean
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)

// Chat-style snap-to-bottom: when a new comment or reply lands AND the
// viewer is already pinned to the bottom of the panel, scroll the new
// entry into view. If the viewer has scrolled UP to read older threads,
// we leave their position alone so the new entry doesn't yank focus.
const { arrivedState } = useScroll(scrollContainer)
let pinnedBeforeUpdate = true
watch(comments, () => {
  // Capture pinned-state at the moment the count changes; do the
  // scroll on the next tick once the new DOM is laid out.
  pinnedBeforeUpdate = arrivedState.bottom
  nextTick(() => {
    if (pinnedBeforeUpdate && scrollContainer.value) {
      scrollContainer.value.scrollTo({
        top: scrollContainer.value.scrollHeight,
        behavior: 'smooth'
      })
    }
  })
}, { flush: 'post' })

const totalCount = computed(() => comments.value.length)
const isEmpty = computed(() => totalCount.value === 0 && draftAnchor.value === null)
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="p-3 border-b border-default flex items-center justify-between shrink-0">
      <div class="flex items-center gap-1.5">
        <UIcon
          name="i-lucide-message-circle"
          class="size-4 text-muted"
        />
        <h3 class="text-sm font-semibold">
          {{ t('comments.title') }}
        </h3>
        <span
          v-if="totalCount > 0"
          class="text-xs text-muted"
        >({{ totalCount }})</span>
      </div>
      <div class="flex items-center gap-1">
        <UTooltip
          v-if="resolvedComments.length > 0"
          :text="t('comments.showResolved')"
        >
          <UButton
            icon="i-lucide-check-check"
            color="neutral"
            :variant="showResolved ? 'soft' : 'ghost'"
            size="xs"
            :aria-label="t('comments.showResolved')"
            :aria-pressed="showResolved"
            data-testid="comments-show-resolved-toggle"
            @click="showResolved = !showResolved"
          />
        </UTooltip>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('common.close')"
          @click="emit('close')"
        />
      </div>
    </div>

    <div
      ref="scrollContainer"
      class="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 bg-muted"
    >
      <!-- Draft thread for an in-progress new comment. Stays at the top
           of the list so the focused composer is always above the fold. -->
      <div
        v-if="draftAnchor"
        class="rounded-md border border-default bg-default p-3 shadow-sm ring-1 ring-primary-500/30"
        data-testid="comment-draft"
      >
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">
          {{ t('comments.draftHeading') }}
        </p>
        <CommentComposer
          :auto-focus="true"
          :placeholder="t('comments.composerPlaceholder')"
          :mentionable-users="mentionableUsers"
          :submit-label="t('comments.post')"
          @submit="submitDraft"
          @cancel="cancelDraft"
        />
      </div>

      <p
        v-if="isEmpty"
        class="text-xs text-muted text-center py-6 px-3"
      >
        {{ t('comments.empty') }}
      </p>

      <!-- Reusable per-thread fragment — defined once, used by the
           three sections below. -->
      <DefineThreadRow v-slot="{ comment: c, muted }">
        <CommentThread
          :comment="c"
          :read-only="readOnly"
          :muted="muted ?? false"
          :mentionable-users="mentionableUsers"
          :focused="focusedCommentId === c.id"
          :viewer-id="viewerId"
          :viewer-name="viewerName"
          @focus="onThreadFocus"
          @delete-comment="deleteComment"
          @resolve="(id) => setResolved(id, true)"
          @unresolve="(id) => setResolved(id, false)"
          @reply="postReply"
          @delete-reply="deleteReply"
        />
      </DefineThreadRow>

      <!-- Active threads. Section header is suppressed when there are no
           orphans + resolved counts so the unsectioned list reads
           cleanly. -->
      <template v-if="activeComments.length > 0">
        <p
          v-if="orphanedComments.length > 0 || (showResolved && resolvedComments.length > 0)"
          class="text-[11px] font-semibold uppercase tracking-wide text-muted px-1 pt-1"
        >
          {{ t('comments.activeSection') }}
        </p>
        <ReuseThreadRow
          v-for="c in activeComments"
          :key="c.id"
          :comment="c"
        />
      </template>

      <template v-if="orphanedComments.length > 0">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted px-1 pt-2">
          {{ t('comments.orphanedSection') }}
        </p>
        <ReuseThreadRow
          v-for="c in orphanedComments"
          :key="c.id"
          :comment="c"
          :muted="true"
        />
      </template>

      <template v-if="showResolved && resolvedComments.length > 0">
        <p
          class="text-[11px] font-semibold uppercase tracking-wide text-muted px-1 pt-2"
          data-testid="comments-resolved-section-heading"
        >
          {{ t('comments.resolvedSection') }}
        </p>
        <ReuseThreadRow
          v-for="c in resolvedComments"
          :key="c.id"
          :comment="c"
          :muted="true"
        />
      </template>
    </div>
  </div>
</template>
