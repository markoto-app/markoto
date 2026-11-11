<script setup lang="ts">
import type { Text as YText } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { EditorView } from '@codemirror/view'
import CommentThread from '~/components/comments/CommentThread.vue'
import CommentComposer from '~/components/comments/CommentComposer.vue'
import { useCommentsContext } from '~/composables/comments/useComments'
import { serializeAnchor, type SerializedAnchor } from '~/utils/comments/commentAnchors'
import { hasAiMention } from '~/utils/comments/commentBody'
import type { MentionableEntry, MentionableUser } from '~/utils/comments/mentionable'

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

// Active AI sessions on this doc, keyed by commentThreadId. Set by an
// awareness watcher: any peer (including the AI itself) advertising an
// `aiSession` with a `commentThreadId` lights up the matching thread
// card with the rainbow-glow border.
const aiActiveThreads = ref<Set<string>>(new Set())
function refreshAiThreads() {
  const next = new Set<string>()
  for (const state of props.awareness.getStates().values()) {
    const ai = state?.aiSession as { commentThreadId?: unknown } | undefined
    if (ai && typeof ai.commentThreadId === 'string' && ai.commentThreadId.length > 0) {
      next.add(ai.commentThreadId)
    }
  }
  aiActiveThreads.value = next
}
refreshAiThreads()
props.awareness.on('change', refreshAiThreads)
onUnmounted(() => props.awareness.off('change', refreshAiThreads))

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
const workspaceMembers = ref<MentionableUser[]>([])

onMounted(async () => {
  if (!props.docWorkspaceId) return
  try {
    const data = await $fetch<{ users: MentionableUser[] }>(`/api/docs/${props.docId}/mentionable-users`)
    workspaceMembers.value = data.users
  } catch {
    // Quietly degrade — the composer still works without typeahead.
  }
})

// AI typeahead entry. Available everywhere the composer is — including
// standalone docs and docs without workspace members — because the
// trigger endpoint authorizes by doc-edit access, not by workspace
// membership. Localized label + description so the row feels like a
// first-class citizen in the picker rather than a dev-only sentinel.
const aiEntry = computed<MentionableEntry>(() => ({
  kind: 'ai',
  id: 'ai',
  name: t('comments.aiEntryName'),
  email: null,
  description: t('comments.aiEntryDescription'),
  // Aliases let the typeahead surface markoto when the user types
  // legacy `@ai` muscle-memory or just `@m` for "markoto". Fuse
  // matches across all keys; including the literal `markoto` makes
  // the prefix-match deterministic even at low fuzzy threshold.
  aliases: ['ai', 'markoto', 'assistant']
}))

// Composer source — AI first (so it surfaces immediately on bare `@`),
// then the workspace members in their original order. Fuse will then
// re-rank by relevance once the user starts typing.
const mentionableUsers = computed<MentionableEntry[]>(() => [
  aiEntry.value,
  ...workspaceMembers.value.map<MentionableEntry>(u => ({ kind: 'user', ...u }))
])

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
  // Fire the AI trigger if the body contains @ai — server validates
  // doc-edit access and login state, so we only need to gate on the
  // viewer being logged in (anonymous can write @ai but it's a no-op).
  if (hasAiMention(body)) maybeTriggerAi(id, null)
}

async function onSubmitReply(commentId: string, body: string) {
  const replyId = postReply(commentId, body)
  // The server only runs the AI for a message the caller wrote that
  // mentions it, so the trigger must name THIS reply — the thread's
  // parent may be somebody else's.
  if (replyId && hasAiMention(body)) maybeTriggerAi(commentId, replyId)
}

const { chatMissing, refresh: refreshAiAvailability } = useAiAvailability()
const commentsRouter = useRouter()

function showAiProviderMissingToast(): void {
  toast.add({
    title: t('aiProvider.missing.chat'),
    icon: 'i-lucide-key-round',
    color: 'warning',
    actions: [{
      label: t('aiProvider.missing.cta'),
      color: 'neutral',
      onClick: () => {
        void commentsRouter.push(AI_SETTINGS_ROUTE)
      }
    }]
  })
}

async function maybeTriggerAi(commentId: string, replyId: string | null) {
  // Anonymous editors (no logged-in user) can write `@ai` in a comment
  // but the server gates AI on login. Skipping the request avoids a
  // guaranteed 401 toast for the common open-edit-doc-and-test case.
  if (viewerId.value === null) return
  // Bring your own key: no chat provider → point at the settings page
  // instead of firing a request the server would refuse.
  if (chatMissing.value) {
    showAiProviderMissingToast()
    return
  }
  try {
    await $fetch(`/api/docs/${props.docId}/comments/${commentId}/trigger-ai`, {
      method: 'POST',
      body: { replyId: replyId ?? undefined }
    })
  } catch (e) {
    const err = e as { statusCode?: number, data?: { code?: string } }
    if (err?.data?.code === 'ai/provider-missing') {
      showAiProviderMissingToast()
      void refreshAiAvailability()
      return
    }
    if (err?.statusCode === 402 || err?.data?.code === 'ai/budget-exhausted') {
      toast.add({
        title: t('comments.aiTriggerExhausted'),
        icon: 'i-lucide-zap-off',
        color: 'warning'
      })
      return
    }
    if (err?.statusCode === 409) {
      // User already has an AI session running on this doc — silent ignore;
      // the running session is more useful than a duplicate-error toast.
      return
    }
    toast.add({
      title: t('comments.aiTriggerFailed'),
      icon: 'i-lucide-alert-triangle',
      color: 'error'
    })
  }
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
  comment: import('~/composables/comments/useComments').DerivedComment
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
  <!-- Whole sidebar panel sits on `bg-muted` (sumi-100, "Mist") so
       the header AND the scrolling list share the same warmer tone.
       Cards inside the list use `bg-default` (sumi-50) and contrast
       against this surround for free. Same surround as the editor
       toolbar and the iframe preview surround — the entire chrome
       around the doc reads as one warm field. -->
  <div class="h-full flex flex-col bg-muted">
    <!-- Panel header: Fraunces title in editorial register, mono
         count in slate caption style. The panel sits inside the
         editor toolbar surface, so its background is the warmer
         `bg-muted` already provided by the parent. -->
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-message-circle"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('comments.title') }}
        </h3>
        <span
          v-if="totalCount > 0"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
        >{{ totalCount }}</span>
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
          class="mk-panel-close"
          data-testid="panel-close"
          :aria-label="t('common.close')"
          @click="emit('close')"
        />
      </div>
    </div>

    <div
      ref="scrollContainer"
      class="flex-1 overflow-y-auto p-2 space-y-2 min-h-0"
    >
      <!-- Draft thread for an in-progress new comment. Stays at the top
           of the list so the focused composer is always above the fold. -->
      <div
        v-if="draftAnchor"
        class="rounded-md border border-default bg-default p-3 shadow-sm ring-1 ring-primary-500/30"
        data-testid="comment-draft"
      >
        <p class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted mb-2">
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
          :ai-active="aiActiveThreads.has(c.id)"
          :viewer-id="viewerId"
          :viewer-name="viewerName"
          @focus="onThreadFocus"
          @delete-comment="deleteComment"
          @resolve="(id) => setResolved(id, true)"
          @unresolve="(id) => setResolved(id, false)"
          @reply="onSubmitReply"
          @delete-reply="deleteReply"
        />
      </DefineThreadRow>

      <!-- Active threads. Section header is suppressed when there are no
           orphans + resolved counts so the unsectioned list reads
           cleanly. -->
      <template v-if="activeComments.length > 0">
        <p
          v-if="orphanedComments.length > 0 || (showResolved && resolvedComments.length > 0)"
          class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted px-1 pt-1"
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
        <p class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted px-1 pt-2">
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
          class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted px-1 pt-2"
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
