<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'
import SuggestionCard from '~/components/suggestions/SuggestionCard.vue'
import { useSuggestionsContext } from '~/composables/suggestions/useSuggestions'
import { useCommentsContext } from '~/composables/comments/useComments'
import { cardIdOf, groupSuggestions } from '~/utils/suggestions/groupSuggestions'

// The suggestions of the document as margin cards, in document order, with
// "Accept all" / "Reject all", optionally for one author. Opened from the
// sidebar tab, by switching to Suggesting, or by clicking (tapping, on a
// phone: the panel is a bottom sheet there) a suggestion in the text.

const props = defineProps<{
  docId: string
  awareness: Awareness
  /** Accept / reject: edits directly. */
  canReview: boolean
  /** Not read-only: may withdraw own suggestions and reply. */
  canWrite: boolean
}>()

const emit = defineEmits<{
  focus: [id: string]
  /** Download the Markdown with the suggestions in CriticMarkup. */
  export: []
  close: []
}>()

const { t } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()
const { suggestions, resolve, withdraw } = useSuggestionsContext()
const { comments, createComment, postReply, deleteReply } = useCommentsContext()

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

/** Filter: one author's suggestions, or all. */
const authorFilter = ref<string>('all')
const authors = computed(() => {
  const seen = new Map<string, string>()
  for (const s of suggestions.value) if (!seen.has(s.authorKey)) seen.set(s.authorKey, s.isAi ? t('suggestions.aiAuthor') : s.authorName)
  return [...seen.entries()].map(([value, label]) => ({ value, label }))
})
const authorItems = computed(() => [{ value: 'all', label: t('suggestions.allAuthors') }, ...authors.value])
watch(authors, (list) => {
  if (authorFilter.value !== 'all' && !list.some(a => a.value === authorFilter.value)) authorFilter.value = 'all'
})
const shown = computed(() => authorFilter.value === 'all' ? suggestions.value : suggestions.value.filter(s => s.authorKey === authorFilter.value))

const cards = computed(() => groupSuggestions(shown.value))

const threadsBySuggestion = computed(() => {
  const map = new Map<string, (typeof comments.value)[number]>()
  for (const c of comments.value) if (c.suggestionId !== null && !map.has(c.suggestionId)) map.set(c.suggestionId, c)
  return map
})

const busyIds = ref<Set<string>>(new Set())
const bulkBusy = ref(false)

async function run(action: 'accept' | 'reject', select: { ids?: string[], authorKey?: string }, announce = false) {
  const ids = select.ids ?? []
  for (const id of ids) busyIds.value.add(id)
  try {
    const result = await resolve(action, select)
    if (announce || !select.ids) {
      toast.add({
        title: t(action === 'accept' ? 'suggestions.acceptedN' : 'suggestions.rejectedN', { n: result.resolved }, result.resolved),
        icon: action === 'accept' ? 'i-lucide-check' : 'i-lucide-x',
        color: action === 'accept' ? 'success' : 'neutral'
      })
    }
  } catch (e) {
    const err = extractError(e)
    toast.add({ title: err.message || t('suggestions.failed'), color: 'error', icon: 'i-lucide-alert-triangle' })
  } finally {
    for (const id of ids) busyIds.value.delete(id)
  }
}

async function bulk(action: 'accept' | 'reject') {
  bulkBusy.value = true
  try {
    await run(action, authorFilter.value === 'all' ? {} : { authorKey: authorFilter.value })
  } finally {
    bulkBusy.value = false
  }
}

function replyTo(suggestionId: string, body: string) {
  const s = suggestions.value.find(x => x.id === suggestionId)
  if (!s) return
  createComment({ start: s.record.start, end: s.record.end }, body, suggestionId)
}

const focusedId = ref<string | null>(null)
const focusFade = useTimeoutFn(() => {
  focusedId.value = null
}, 1600, { immediate: false })

function onFocus(id: string) {
  focusedId.value = id
  focusFade.start()
  emit('focus', id)
}

/** Called by the layout when a suggestion is clicked in the text. */
function focusSuggestion(id: string) {
  authorFilter.value = 'all'
  // The card shows a whole group: any member id leads to it.
  const groups = groupSuggestions(suggestions.value)
  id = cardIdOf(groups, id)
  focusedId.value = id
  focusFade.start()
  void nextTick(() => {
    document.querySelector(`[data-suggestion-card="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

defineExpose({ focusSuggestion })
</script>

<template>
  <div
    class="h-full flex flex-col bg-muted"
    data-testid="suggestions-panel"
  >
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-file-diff"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('suggestions.title') }}
        </h3>
        <span
          v-if="suggestions.length > 0"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
          data-testid="suggestions-count"
        >{{ suggestions.length }}</span>
      </div>
      <UTooltip
        v-if="suggestions.length > 0"
        :text="t('suggestions.exportCritic')"
      >
        <UButton
          icon="i-lucide-download"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('suggestions.exportCritic')"
          data-testid="suggestions-export"
          @click="emit('export')"
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

    <div
      v-if="suggestions.length > 0"
      class="px-2 pt-2 flex flex-col gap-1.5 shrink-0"
    >
      <!-- The bulk buttons come first so they keep their place when the author
           filter below appears or goes away (a misclick on "Accept all"). -->
      <div
        v-if="canReview"
        class="flex flex-wrap items-center gap-1.5"
      >
        <UButton
          icon="i-lucide-check-check"
          color="neutral"
          variant="soft"
          size="xs"
          :loading="bulkBusy"
          data-testid="suggestions-accept-all"
          @click="bulk('accept')"
        >
          {{ authorFilter === 'all' ? t('suggestions.acceptAll') : t('suggestions.acceptShown') }}
        </UButton>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="bulkBusy"
          data-testid="suggestions-reject-all"
          @click="bulk('reject')"
        >
          {{ authorFilter === 'all' ? t('suggestions.rejectAll') : t('suggestions.rejectShown') }}
        </UButton>
      </div>
      <USelect
        v-if="authors.length > 1"
        v-model="authorFilter"
        :items="authorItems"
        size="xs"
        class="w-full min-w-0"
        :aria-label="t('suggestions.filterAuthor')"
        data-testid="suggestions-author-filter"
      />
    </div>

    <div class="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
      <p
        v-if="suggestions.length === 0"
        class="text-xs text-muted text-center py-6 px-3"
        data-testid="suggestions-empty"
      >
        {{ canWrite ? t('suggestions.empty') : t('suggestions.emptyReadOnly') }}
      </p>
      <SuggestionCard
        v-for="c in cards"
        :key="c.primary.id"
        :suggestion="c.primary"
        :members="c.members"
        :can-review="canReview"
        :can-reply="canWrite"
        :thread="threadsBySuggestion.get(c.primary.id) ?? null"
        :focused="focusedId === c.primary.id"
        :busy="c.members.some(m => busyIds.has(m.id))"
        :viewer-id="viewerId"
        :viewer-name="viewerName"
        @focus="onFocus"
        @accept="(ids) => run('accept', { ids }, ids.length > 1)"
        @reject="(ids) => run('reject', { ids }, ids.length > 1)"
        @withdraw="withdraw"
        @reply="replyTo"
        @reply-thread="(threadId, body) => postReply(threadId, body)"
        @delete-reply="(threadId, replyId) => deleteReply(threadId, replyId)"
      />
    </div>
  </div>
</template>
