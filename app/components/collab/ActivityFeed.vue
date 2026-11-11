<script setup lang="ts">
import type * as Y from 'yjs'
import {
  categoryOf as _categoryOf,
  isExpandable as _isExpandable,
  expansionToggleLabelKey,
  type FilterKey
} from '~/utils/collab/activityFeedHelpers'

// Lazy-loaded so the per-kind expansion deps ship only when a card is expanded.
const ActivityRowDiff = defineAsyncComponent(() => import('./ActivityRowDiff.vue'))
const ActivityRowCommentContext = defineAsyncComponent(() => import('./ActivityRowCommentContext.vue'))
const ActivityRowAiTool = defineAsyncComponent(() => import('./ActivityRowAiTool.vue'))
const RestoreConfirmModal = defineAsyncComponent(() => import('./RestoreConfirmModal.vue'))

const props = defineProps<{
  docId: string
  ydoc?: Y.Doc | null
  /** Hides the restore button on every row (viewers who can't edit). */
  readOnly?: boolean
}>()

const { t } = useI18n()
const { showContextualError } = useErrorHandler()
const loadErrored = ref(false)

type ActivityAction
  = | 'edit' | 'join' | 'leave'
    | 'comment.added' | 'comment.replied' | 'comment.resolved' | 'comment.reopened' | 'comment.deleted'
    | 'theme.changed' | 'title.changed' | 'ai.tool'
    | 'restore'

interface ActivityMetadataAdded { kind: 'comment.added' | 'comment.resolved' | 'comment.reopened', commentId: string, bodyPreview: string }
interface ActivityMetadataReplied { kind: 'comment.replied', commentId: string, parentCommentId: string, bodyPreview: string }
interface ActivityMetadataDeleted { kind: 'comment.deleted', commentId: string, bodyPreview: string, isReply: boolean }
interface ActivityMetadataTitle { kind: 'title.changed', from: string, to: string }
interface ActivityMetadataTheme { kind: 'theme.changed' }
interface ActivityMetadataAiTool {
  kind: 'ai.tool'
  tool: 'web_search' | 'fetch_url' | 'generate_image' | 'view_image' | 'search_knowledge' | 'get_knowledge_file'
  query?: string
  url?: string
  prompt?: string
  src?: string
  knowledgeId?: string
}
interface ActivityMetadataRestore {
  kind: 'restore'
  restoredFromActivityId: number
  restoredFromTime: string
}
type ActivityMetadata
  = | ActivityMetadataAdded | ActivityMetadataReplied | ActivityMetadataDeleted
    | ActivityMetadataTitle | ActivityMetadataTheme | ActivityMetadataAiTool
    | ActivityMetadataRestore

interface ActivityEntry {
  id: number
  docId: string
  userId: number | null
  userName: string | null
  action: ActivityAction
  wordCount: number | null
  linesAdded: number | null
  linesRemoved: number | null
  metadata: ActivityMetadata | null
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
  // Agent-driven rows carry a synthetic principal ('ai:assistant:{sid}' /
  // 'mcp:{sid}'); the resolved agent* fields come from the server's join to
  // ai_sessions / mcp_sessions. All null for human rows. Anonymous rows carry
  // the editor's per-tab avatar token so the row shows the same face as the
  // presence bar.
  actorPrincipal: string | null
  actorAvatarSeed?: string | null
  agentKind: 'ai' | 'mcp' | null
  agentInitiatorUserId: number | null
  agentInitiatorName: string | null
  agentClientName: string | null
  createdAt: string | number
}

// Days of history the document's plan includes; set only when older rows are hidden.
const historyLimitedDays = ref<number | null>(null)

const {
  state: entries,
  isLoading: loading,
  execute: loadActivity
} = useAsyncState<ActivityEntry[]>(
  async () => {
    const res = await $fetch.raw<ActivityEntry[]>(`/api/docs/${props.docId}/activity`)
    loadErrored.value = false
    // Present when the plan limits history and older rows exist
    // (server/utils/billing/entitlements.ts#HISTORY_LIMITED_HEADER).
    const limitedDays = Number(res.headers.get('x-markoto-history-limited-days'))
    historyLimitedDays.value = Number.isFinite(limitedDays) && limitedDays > 0 ? limitedDays : null
    return res._data ?? []
  },
  [],
  {
    immediate: true,
    resetOnExecute: false,
    onError: (e) => {
      if (!loadErrored.value) showContextualError(e, 'error.activityLoadFailed')
      loadErrored.value = true
      entries.value = []
    }
  }
)

// Safety-net poll: covers join/leave entries and missed updates. Paused while
// the tab is hidden.
const visibility = useDocumentVisibility()
const { pause, resume } = useIntervalFn(loadActivity, 30_000)
watch(visibility, (v) => {
  if (v === 'visible') {
    loadActivity()
    resume()
  } else {
    pause()
  }
})

// The sync server debounces activity logging 2-10 s after the last change, so
// refetch ~3 s after the doc stops changing.
const debouncedReload = useDebounceFn(loadActivity, 3_000)
function onYUpdate() {
  debouncedReload()
}

watch(() => props.ydoc, (doc, prev) => {
  prev?.off('update', onYUpdate)
  doc?.on('update', onYUpdate)
}, { immediate: true })

onUnmounted(() => {
  pause()
  props.ydoc?.off('update', onYUpdate)
})

// Small per-action icon next to the verb. AI rows keep their action icon; the
// AI identity is carried by the avatar.
const actionIcons: Record<ActivityAction, string> = {
  'edit': 'i-lucide-pencil',
  'join': 'i-lucide-log-in',
  'leave': 'i-lucide-log-out',
  'comment.added': 'i-lucide-message-square-plus',
  'comment.replied': 'i-lucide-message-square-reply',
  'comment.resolved': 'i-lucide-check-circle-2',
  'comment.reopened': 'i-lucide-rotate-ccw',
  'comment.deleted': 'i-lucide-message-square-x',
  'title.changed': 'i-lucide-text-cursor-input',
  'theme.changed': 'i-lucide-palette',
  'ai.tool': 'i-lucide-wrench',
  // Same "go back" meaning as comment.reopened's rotate-ccw, told apart by the clock glyph.
  'restore': 'i-lucide-history'
}

const aiToolIcons: Record<ActivityMetadataAiTool['tool'], string> = {
  web_search: 'i-lucide-search',
  fetch_url: 'i-lucide-link',
  generate_image: 'i-lucide-image-plus',
  view_image: 'i-lucide-image',
  search_knowledge: 'i-lucide-book-open',
  get_knowledge_file: 'i-lucide-file-text'
}

function iconFor(entry: ActivityEntry): string {
  if (entry.action === 'ai.tool' && entry.metadata?.kind === 'ai.tool') {
    return aiToolIcons[entry.metadata.tool] ?? actionIcons['ai.tool']
  }
  return actionIcons[entry.action] || 'i-lucide-activity'
}

function detailFor(entry: ActivityEntry): string | null {
  const m = entry.metadata
  if (!m) return null
  switch (m.kind) {
    case 'comment.added':
    case 'comment.replied':
    case 'comment.resolved':
    case 'comment.reopened':
    case 'comment.deleted':
      return m.bodyPreview ? truncate(m.bodyPreview, 200) : null
    case 'title.changed':
      return t('activity.detail.titleChanged', {
        from: truncate(m.from || t('activity.untitled'), 40),
        to: truncate(m.to || t('activity.untitled'), 40)
      })
    case 'ai.tool':
      return detailForAiTool(m)
    case 'restore':
      // Relative to the source row's timestamp, formatted like the row's own.
      return t('activity.detail.restoredFrom', { ago: formatTime(m.restoredFromTime) })
    default:
      return null
  }
}

/** Each AI tool has its own salient field (web_search -> query, fetch_url -> url, ...). */
function detailForAiTool(m: ActivityMetadataAiTool): string | null {
  const formatters: Record<ActivityMetadataAiTool['tool'], (m: ActivityMetadataAiTool) => string | null> = {
    web_search: m => m.query ? `"${truncate(m.query, 120)}"` : null,
    fetch_url: m => m.url ? truncate(m.url, 120) : null,
    generate_image: m => m.prompt ? `"${truncate(m.prompt, 120)}"` : null,
    view_image: m => m.src ? truncate(m.src, 120) : null,
    search_knowledge: m => m.query ? `"${truncate(m.query, 120)}"` : null,
    get_knowledge_file: m => m.knowledgeId ? truncate(m.knowledgeId, 64) : null
  }
  return formatters[m.tool]?.(m) ?? null
}

function actionLabel(entry: ActivityEntry): string {
  if (entry.action === 'ai.tool' && entry.metadata?.kind === 'ai.tool') {
    return t(`activity.action.aiTool.${entry.metadata.tool}`)
  }
  // comment.deleted has a thread/reply variant (metadata.isReply)
  if (entry.action === 'comment.deleted' && entry.metadata?.kind === 'comment.deleted' && entry.metadata.isReply) {
    return t('activity.action.comment.deletedReply')
  }
  return t(`activity.action.${entry.action}`)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Ticks every 30 s (matches the poll cadence; labels change per minute) so
// relative-time labels roll over without waiting for a refetch.
const now = useNow({ interval: 30_000 })

function formatTime(ts: string | number) {
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  const diff = now.value.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('activity.justNow')
  if (mins < 60) return t('activity.minutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('activity.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('activity.daysAgo', { count: days })
}

// `all` shows everything; the others narrow to a category (shared helper).
const activeFilter = ref<FilterKey>('all')

function categoryOf(entry: ActivityEntry): FilterKey {
  return _categoryOf(entry)
}

const counts = computed(() => {
  const c = { all: 0, edits: 0, comments: 0, ai: 0, meta: 0 } as Record<FilterKey, number>
  for (const e of entries.value) {
    c.all += 1
    const k = categoryOf(e)
    if (k !== 'all') c[k] += 1
  }
  return c
})

const filteredEntries = computed(() => {
  if (activeFilter.value === 'all') return entries.value
  return entries.value.filter(e => categoryOf(e) === activeFilter.value)
})

// The `ai` chip uses the brand seal; `icon: null` tells the template to render
// `<CommonSeal>` instead of a Lucide glyph.
const FILTER_CHIPS: Array<{ key: FilterKey, icon: string | null }> = [
  { key: 'all', icon: 'i-lucide-list' },
  { key: 'edits', icon: 'i-lucide-pencil' },
  { key: 'comments', icon: 'i-lucide-message-square' },
  { key: 'ai', icon: null },
  { key: 'meta', icon: 'i-lucide-settings-2' }
]

// An agent row is any activity by a non-human principal (in-app AI loop or
// MCP). `agentKind` is resolved server-side from `actor_principal`; the
// userName fallbacks cover rows without it:
//   - 'AI Assistant': AI rows from before actor_principal existed.
//   - 'markoto': comment-snapshot rows (author stored in Y.js, no principal),
//     shared by AI and MCP comments via `handleCreateComment`.
//   - 'MCP': defensive fallback for an MCP row missing actor_principal.
function isAgent(entry: ActivityEntry): boolean {
  if (entry.agentKind !== null) return true
  return entry.userName === 'AI Assistant'
    || entry.userName === 'markoto'
    || entry.userName === 'MCP'
}

/**
 * Prefers the resolved initiator (the human who triggered the agent), like the
 * live PresenceBar ("Helping Joel"); falls back to the raw userName when the
 * session was swept.
 */
function displayName(entry: ActivityEntry): string {
  if (entry.agentInitiatorName) return entry.agentInitiatorName
  return entry.userName ?? t('activity.anonymous')
}

/**
 * "via {label}" badge text for agent rows; empty for human rows.
 *   - MCP: `agentClientName` (already falls back to userAgent)
 *   - AI: a fixed label; the in-app loop has no per-client distinction
 */
function agentBadgeText(entry: ActivityEntry): string {
  if (entry.agentKind === 'mcp') return entry.agentClientName ?? 'MCP'
  if (entry.agentKind === 'ai') return 'markoto AI'
  // Name-detected agent rows without actor_principal get no badge: it would
  // be an invented label.
  return ''
}

// Expanded activity ids; several cards can be open at once so diffs can be compared.
const expandedIds = ref<Set<number>>(new Set())

// Eligibility lives in a pure helper (`app/utils/collab/activityFeedHelpers.ts`)
// so it has a single test target; this wrapper only adapts the type.
function isExpandable(entry: ActivityEntry): boolean {
  return _isExpandable(entry)
}

/**
 * Which expansion component to mount for an entry, with its props (the
 * AI-tool drawer reads from metadata, not the endpoint).
 */
function expansionFor(entry: ActivityEntry): { is: unknown, props: Record<string, unknown> } | null {
  if (entry.action === 'edit') {
    return { is: ActivityRowDiff, props: { docId: props.docId, activityId: entry.id } }
  }
  if (entry.action.startsWith('comment.')) {
    return { is: ActivityRowCommentContext, props: { docId: props.docId, activityId: entry.id } }
  }
  if (entry.action === 'ai.tool' && entry.metadata?.kind === 'ai.tool') {
    return { is: ActivityRowAiTool, props: { metadata: entry.metadata } }
  }
  // Restore rows carry yjsDocIdBefore/After, so the /diff endpoint yields a
  // meaningful diff and ActivityRowDiff is reused.
  if (entry.action === 'restore') {
    return { is: ActivityRowDiff, props: { docId: props.docId, activityId: entry.id } }
  }
  return null
}

/** Resolves the helper's i18n key for the expansion toggle label. */
function expansionToggleLabel(entry: ActivityEntry, expanded: boolean): string {
  const key = expansionToggleLabelKey(entry, expanded)
  return key ? t(key) : ''
}

function toggleExpanded(entry: ActivityEntry) {
  if (!isExpandable(entry)) return
  const next = new Set(expandedIds.value)
  if (next.has(entry.id)) next.delete(entry.id)
  else next.add(entry.id)
  expandedIds.value = next
}

function isExpanded(entry: ActivityEntry): boolean {
  return expandedIds.value.has(entry.id)
}

// "Restore to this point" shows on rows with a usable `yjsDocIdBefore`.
// Read-only viewers get no button at all (hidden, not disabled: a disabled
// control suggests access they don't have).

const restoreModalOpen = ref(false)
const restoreCandidate = ref<{ activityId: number, whenLabel: string } | null>(null)

function isRestorable(entry: ActivityEntry): boolean {
  // Rows without a boundary id (yjsDocIdBefore === null) are hidden: the
  // endpoint would answer 410.
  if (props.readOnly) return false
  if (entry.yjsDocIdBefore === null) return false
  // A `restore` row is restorable too; restoring is itself reversible.
  return true
}

function openRestoreModal(entry: ActivityEntry) {
  if (!isRestorable(entry)) return
  restoreCandidate.value = {
    activityId: entry.id,
    whenLabel: formatTime(entry.createdAt)
  }
  restoreModalOpen.value = true
}

function onRestored() {
  // Refetch now rather than waiting for the 30 s poll. The editor body
  // updates through the Hocuspocus broadcast.
  loadActivity()
}
</script>

<template>
  <div class="space-y-2">
    <!-- Hidden when the feed is empty. -->
    <div
      v-if="!loading && entries.length > 0"
      class="flex flex-wrap gap-1 pb-1.5 border-b border-default/60"
    >
      <!-- Active chip is sumi-toned, not shu: shu is reserved for AI presence. -->
      <button
        v-for="chip in FILTER_CHIPS"
        :key="chip.key"
        type="button"
        :disabled="counts[chip.key] === 0 && chip.key !== 'all'"
        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-colors"
        :class="activeFilter === chip.key
          ? 'bg-elevated text-default'
          : 'text-muted hover:bg-elevated/60 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed'"
        @click="activeFilter = chip.key"
      >
        <UIcon
          v-if="chip.icon"
          :name="chip.icon"
          class="size-3"
        />
        <CommonSeal
          v-else
          :size="9"
        />
        {{ t(`activity.filter.${chip.key}`) }}
        <span class="font-mono text-[10px] tracking-[0.04em] text-muted opacity-80">{{ counts[chip.key] }}</span>
      </button>
    </div>

    <div
      v-if="loading"
      class="flex justify-center py-4"
    >
      <UIcon
        name="i-lucide-loader"
        class="size-5 animate-spin text-muted"
      />
    </div>
    <div
      v-else-if="entries.length === 0"
      class="text-sm text-muted text-center py-4"
    >
      {{ t('activity.noActivity') }}
    </div>
    <div
      v-else-if="filteredEntries.length === 0"
      class="text-sm text-muted text-center py-4"
    >
      {{ t('activity.noFilterMatches') }}
    </div>

    <!-- Card style mirrors `CommentThread.vue:.comment-thread-card` so the Comments
         and Activity sidebars look alike. Expandable rows toggle a drawer on click. -->
    <div
      v-for="entry in filteredEntries"
      :key="entry.id"
      class="rounded-md border border-default bg-default shadow-sm transition-shadow hover:shadow-md hover:border-primary/40"
      :class="isExpandable(entry) ? 'cursor-pointer' : ''"
      :data-activity-id="entry.id"
      :data-expanded="isExpanded(entry) ? 'true' : 'false'"
      @click="toggleExpanded(entry)"
    >
      <div class="p-3 flex gap-2.5">
        <!-- Agents get the seal disc; humans their generated face (seeded by
             user id, or by display name for anonymous / deleted users). -->
        <!-- Same seal for AI loop and MCP; the badge text tells them apart. -->
        <div
          v-if="isAgent(entry)"
          class="shrink-0 mt-0.5 size-7 rounded-full flex items-center justify-center bg-default border border-default"
          :title="displayName(entry)"
        >
          <CommonSeal :size="9" />
        </div>
        <CommonUserAvatar
          v-else
          :seed="avatarSeedFor({ id: entry.userId, avatarSeed: entry.actorAvatarSeed, fallback: entry.userName })"
          :size="28"
          class="mt-0.5"
        />

        <div class="flex-1 min-w-0 leading-snug">
          <div class="flex items-baseline gap-2 text-xs flex-wrap">
            <span class="font-semibold text-default truncate">
              {{ displayName(entry) }}
            </span>
            <!-- "via {agent}" badge: marks edits made through an agent. Empty for
                 human rows and name-detected agent rows. -->
            <span
              v-if="agentBadgeText(entry)"
              class="font-mono text-[10px] uppercase tracking-wider text-muted shrink-0"
              :title="entry.actorPrincipal ?? undefined"
            >
              via {{ agentBadgeText(entry) }}
            </span>
            <span class="text-muted shrink-0">{{ formatTime(entry.createdAt) }}</span>
          </div>

          <div class="mt-0.5 text-sm text-muted flex items-center gap-1.5 flex-wrap">
            <UIcon
              :name="iconFor(entry)"
              class="size-3.5 shrink-0"
              :class="isAgent(entry) ? 'text-amber-500' : 'text-muted'"
            />
            <span>{{ actionLabel(entry) }}</span>
            <span
              v-if="entry.action === 'edit' && (entry.linesAdded || entry.linesRemoved)"
              class="inline-flex items-center gap-1 text-xs font-mono"
            >
              <span
                v-if="entry.linesAdded"
                class="text-green-500"
              >+{{ entry.linesAdded }}</span>
              <span
                v-if="entry.linesRemoved"
                class="text-red-500"
              >-{{ entry.linesRemoved }}</span>
            </span>
          </div>

          <!-- Detail line (comment preview, AI tool query/url, title change), italic like a quote. -->
          <div
            v-if="detailFor(entry)"
            class="mt-1 text-xs text-default/80 italic break-words line-clamp-2"
            :title="detailFor(entry) || undefined"
          >
            {{ detailFor(entry) }}
          </div>

          <!-- Caret (left) and restore button (right). The restore button uses
               @click.stop so it doesn't also toggle expansion. -->
          <div
            v-if="isExpandable(entry) || isRestorable(entry)"
            class="mt-1 flex items-center justify-between gap-2 text-[11px]"
          >
            <div
              v-if="isExpandable(entry)"
              class="flex items-center gap-1 text-muted"
            >
              <UIcon
                name="i-lucide-chevron-down"
                class="size-3 transition-transform"
                :class="isExpanded(entry) ? 'rotate-180' : ''"
              />
              <span>{{ expansionToggleLabel(entry, isExpanded(entry)) }}</span>
            </div>
            <button
              v-if="isRestorable(entry)"
              type="button"
              class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-elevated text-muted hover:text-primary transition-colors"
              :title="t('activity.restore.button.tooltip')"
              :data-testid="`activity-row-restore-${entry.id}`"
              @click.stop="openRestoreModal(entry)"
            >
              <UIcon
                name="i-lucide-history"
                class="size-3"
              />
              <span>{{ t('activity.restore.button.label') }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Mounted only when expanded so the lazy component and its request load
           on demand. Stops click propagation so clicks inside don't collapse the card. -->
      <div
        v-if="isExpanded(entry) && expansionFor(entry)"
        class="border-t border-default/60 bg-muted/30 px-3 py-2"
        @click.stop
      >
        <component
          :is="expansionFor(entry)!.is"
          v-bind="expansionFor(entry)!.props"
        />
      </div>
    </div>

    <CommonPlanLimitNotice
      v-if="historyLimitedDays !== null"
      message-key="plan.notice.historyHidden"
      :params="{ days: historyLimitedDays }"
      data-testid="activity-history-limited"
    />

    <!-- Single instance driven by `restoreCandidate`. -->
    <RestoreConfirmModal
      v-if="restoreCandidate"
      v-model:open="restoreModalOpen"
      :doc-id="docId"
      :activity-id="restoreCandidate.activityId"
      :when-label="restoreCandidate.whenLabel"
      @restored="onRestored"
    />
  </div>
</template>
