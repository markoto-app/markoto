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
  /** Read-only viewers can browse threads but not author or mutate (mirrors the parent's `isReadOnly`). */
  readOnly: boolean
}>()

const emit = defineEmits<{
  /** User clicked a thread or just posted a draft → scroll editor to that anchor. */
  focus: [id: string]
  close: []
}>()

const { t } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()
const { budgetActions } = useAiWayForward()

const {
  comments,
  createComment,
  deleteComment,
  setResolved,
  postReply,
  deleteReply
} = useCommentsContext()

// Local viewer identity: CommentThread uses it to gate Delete (authors only).
// Refreshed on awareness updates.
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

// Active AI sessions keyed by commentThreadId, from an awareness watcher: a
// peer advertising an `aiSession` with a `commentThreadId` lights up that thread.
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

// Active = anchored and unresolved; orphaned = no anchor; resolved = explicitly resolved.
// Reply threads of suggestions belong to the suggestion's card (SuggestionsPanel).
const threads = computed(() => comments.value.filter(c => c.suggestionId === null))
const activeComments = computed(() => threads.value.filter(c => c.anchor !== null && !c.resolved))
const orphanedComments = computed(() => threads.value.filter(c => c.anchor === null && !c.resolved))
const resolvedComments = computed(() => threads.value.filter(c => c.resolved))

const showResolved = ref(false)

// Fetched only for workspace docs the viewer belongs to (mirrors the server
// gate); otherwise empty and the composer shows no popover.
const workspaceMembers = ref<MentionableUser[]>([])

onMounted(async () => {
  if (!props.docWorkspaceId) return
  try {
    const data = await apiFetch('/api/docs/:docId/mentionable-users', { path: { docId: props.docId } })
    workspaceMembers.value = data.users
  } catch {
    // Degrade quietly: the composer works without typeahead.
  }
})

// AI typeahead entry, offered on every doc (the trigger endpoint authorizes by
// doc-edit access, not workspace membership).
const aiEntry = computed<MentionableEntry>(() => ({
  kind: 'ai',
  id: 'ai',
  name: t('comments.aiEntryName'),
  email: null,
  description: t('comments.aiEntryDescription'),
  // Aliases surface markoto for legacy `@ai` or `@m`; including the literal
  // `markoto` keeps the prefix match deterministic at a low fuzzy threshold.
  aliases: ['ai', 'markoto', 'assistant']
}))

// AI first (so it shows on a bare `@`), then workspace members; Fuse re-ranks once the user types.
const mentionableUsers = computed<MentionableEntry[]>(() => [
  aiEntry.value,
  ...workspaceMembers.value.map<MentionableEntry>(u => ({ kind: 'user', ...u }))
])

// The toolbar / menu / keyboard route here for a new comment. The anchor is
// held locally; nothing is written to Y.js until the composer submits.
const draftAnchor = ref<SerializedAnchor | null>(null)
const focusedCommentId = ref<string | null>(null)
// Clears `focusedCommentId` 1.2 s after focus; calling `start()` again restarts the timer.
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
  // Scroll to the top, where the draft renders.
  void nextTick(() => {
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
  // Fire the AI trigger if the body contains @ai. The server validates edit
  // access and login, so only the logged-in gate is needed here.
  if (hasAiMention(body)) void maybeTriggerAi(id, null)
}

async function onSubmitReply(commentId: string, body: string) {
  const replyId = postReply(commentId, body)
  // The server runs the AI only for a message the caller wrote that mentions
  // it, so the trigger must name THIS reply (the parent may be someone else's).
  if (replyId && hasAiMention(body)) void maybeTriggerAi(commentId, replyId)
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
  // Anonymous editors can write `@ai` but the server gates AI on login;
  // skipping avoids a guaranteed 401 toast.
  if (viewerId.value === null) return
  // Bring your own key: no chat provider → point at the settings page
  // instead of firing a request the server would refuse.
  if (chatMissing.value) {
    showAiProviderMissingToast()
    return
  }
  try {
    await apiFetch('/api/docs/:docId/comments/:commentId/trigger-ai', {
      method: 'post',
      path: { docId: props.docId, commentId },
      body: { replyId: replyId ?? undefined }
    })
  } catch (e) {
    // The code sits in the response body's own `data`; extractError unwraps it.
    const err = extractError(e)
    if (err.code === 'ai/provider-missing') {
      showAiProviderMissingToast()
      void refreshAiAvailability()
      return
    }
    if (err.statusCode === 402 || err.code === 'ai/budget-exhausted') {
      toast.add({
        title: t('comments.aiTriggerExhausted'),
        icon: 'i-lucide-zap-off',
        color: 'warning',
        actions: budgetActions()
      })
      return
    }
    if (err.statusCode === 409) {
      // An AI session already runs on this doc: ignore silently rather than toast a duplicate error.
      return
    }
    toast.add({
      title: t('comments.aiTriggerFailed'),
      icon: 'i-lucide-alert-triangle',
      color: 'error'
    })
  }
}

function onThreadFocus(id: string) {
  highlight(id)
  emit('focus', id)
}

function highlight(id: string) {
  focusedCommentId.value = id
  // Calling start() while pending cancels and reschedules the callback.
  focusFade.start()
}

// The parent (EditorLayout) calls `focusComment(id)` on the editor's
// `comment:focus` (a click on the in-doc underline) to highlight and scroll the thread.
function focusComment(id: string) {
  const el = document.querySelector(`[data-comment-id="${id}"]`)
  if (el && 'scrollIntoView' in el) {
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  highlight(id)
}

defineExpose({ startDraft, focusComment })

// Reusable fragment for the active / orphaned / resolved sections; only the
// data source and the `muted` flag differ.
const [DefineThreadRow, ReuseThreadRow] = createReusableTemplate<{
  comment: import('~/composables/comments/useComments').DerivedComment
  muted?: boolean
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)

// Chat-style snap-to-bottom: a new comment or reply scrolls into view only if
// the viewer is already pinned to the bottom, so reading older threads isn't interrupted.
const { arrivedState } = useScroll(scrollContainer)
let pinnedBeforeUpdate = true
watch(comments, () => {
  // Capture pinned state when the count changes; scroll next tick once the DOM is laid out.
  pinnedBeforeUpdate = arrivedState.bottom
  void nextTick(() => {
    if (pinnedBeforeUpdate && scrollContainer.value) {
      scrollContainer.value.scrollTo({
        top: scrollContainer.value.scrollHeight,
        behavior: 'smooth'
      })
    }
  })
}, { flush: 'post' })

const totalCount = computed(() => threads.value.length)
const isEmpty = computed(() => totalCount.value === 0 && draftAnchor.value === null)
</script>

<template>
  <!-- The panel sits on `bg-muted` so header and list share one tone; cards
       use `bg-default` and contrast with it, like the toolbar and preview surround. -->
  <div class="h-full flex flex-col bg-muted">
    <!-- Header: Fraunces title, mono count. -->
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
      <!-- Draft thread, kept at the top so the focused composer is above the fold. -->
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

      <!-- Header is hidden when there are no orphans or resolved threads. -->
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
