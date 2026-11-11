<script setup lang="ts">
import type * as Y from 'yjs'
import {
  categoryOf as _categoryOf,
  isExpandable as _isExpandable,
  expansionToggleLabelKey,
  type FilterKey
} from '~/utils/activityFeedHelpers'

// Lazy-load the per-kind expansion components so their deps don't
// ship until a user actually expands a card.
const ActivityRowDiff = defineAsyncComponent(() => import('./ActivityRowDiff.vue'))
const ActivityRowCommentContext = defineAsyncComponent(() => import('./ActivityRowCommentContext.vue'))
const ActivityRowAiTool = defineAsyncComponent(() => import('./ActivityRowAiTool.vue'))
// Restore confirm modal — also lazy-loaded so the modal markup +
// toast wiring don't ship until the user actually clicks restore.
const RestoreConfirmModal = defineAsyncComponent(() => import('./RestoreConfirmModal.vue'))

const props = defineProps<{
  docId: string
  ydoc?: Y.Doc | null
  /** When true, the actor can't apply restores (the button is hidden
   *  on every row). Drives the same gate the prompt-bar uses for
   *  send-disabled. Defaults to false so anonymous-edit docs and
   *  legitimate editors can still restore. */
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
  // Phase-3 unified attribution. `actorPrincipal` carries the
  // synthetic principal string ('ai:assistant:{sid}' / 'mcp:{sid}')
  // for agent-driven rows; the resolved fields below are populated
  // by `enrichActivityAgentFields` server-side via JOIN to
  // ai_sessions / mcp_sessions → users. Null for human rows and for
  // legacy AI rows that pre-date the actor_principal column.
  actorPrincipal: string | null
  // Anonymous rows: the editor's random per-tab avatar token (the one
  // their presence broadcast), so the row shows the same face. Absent
  // or null for everyone else and for older rows.
  actorAvatarSeed?: string | null
  agentKind: 'ai' | 'mcp' | null
  agentInitiatorUserId: number | null
  agentInitiatorName: string | null
  agentClientName: string | null
  createdAt: string | number
}

// Days of history the document's plan includes, when older rows are hidden.
const historyLimitedDays = ref<number | null>(null)

const {
  state: entries,
  isLoading: loading,
  execute: loadActivity
} = useAsyncState<ActivityEntry[]>(
  async () => {
    const res = await $fetch.raw<ActivityEntry[]>(`/api/docs/${props.docId}/activity`)
    loadErrored.value = false
    // Set when the document's plan limits how far back history goes and
    // older rows exist (server/utils/billing/entitlements.ts#HISTORY_LIMITED_HEADER).
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

// Safety-net poll — covers join/leave entries and recovers from missed
// updates. Pause when the tab is hidden, re-fire on visible.
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

// Sync-server debounces `onStoreDocument` (and therefore activity logging) at
// 2-10 s after the last change. Refetch ~3 s after the doc stops changing.
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

// Per-action small icon (rendered next to the verb on each card). For
// AI rows we still use the action-specific icon next to the verb — the
// sparkles identity is carried by the avatar fallback so we don't lose
// it. The card-shaped layout makes "who did what" the dominant signal.
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
  // History/rewind icon — universally legible "this is a time-travel
  // operation" symbol; collides with comment.reopened's rotate-ccw
  // semantically (both are "go back") but visually distinct via the
  // clock-face glyph.
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
      // "From {N minutes ago}" relative to the source activity row's
      // captured timestamp. Going through formatTime gives the same
      // output style as the row's own timestamp, so the user sees
      // the temporal relationship at a glance.
      return t('activity.detail.restoredFrom', { ago: formatTime(m.restoredFromTime) })
    default:
      return null
  }
}

/**
 * Per-AI-tool detail formatter. Each tool has its own salient field
 * (web_search → query, fetch_url → url, etc.). Routed through a small
 * registry to keep the parent switch flat.
 */
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
  // comment.deleted has a "thread" vs "reply" variant driven by metadata.isReply
  if (entry.action === 'comment.deleted' && entry.metadata?.kind === 'comment.deleted' && entry.metadata.isReply) {
    return t('activity.action.comment.deletedReply')
  }
  return t(`activity.action.${entry.action}`)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Reactive "now" ticking every 30s. Drives the relative-time labels
// on every card so a card stamped "just now" rolls to "1 minute ago"
// without waiting for the polling refetch. 30s matches the polling
// cadence — finer ticks would just rerender mid-second for a label
// that only changes per minute. Implementation lives in @vueuse/core
// (uses one shared interval, pauses with the tab). Without it, labels
// freeze between the 30s polls and "5 minutes ago" can read as "just
// now" for half a minute.
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

// Filter chips. `all` shows everything; the others narrow to a
// category. Branching lives in the shared pure helper for testability.
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

// Filter chips. The `ai` chip's icon is the brand seal, not a Lucide
// sparkles glyph — `icon: null` is the sentinel that tells the
// template to render `<CommonSeal>` in that slot instead.
const FILTER_CHIPS: Array<{ key: FilterKey, icon: string | null }> = [
  { key: 'all', icon: 'i-lucide-list' },
  { key: 'edits', icon: 'i-lucide-pencil' },
  { key: 'comments', icon: 'i-lucide-message-square' },
  { key: 'ai', icon: null },
  { key: 'meta', icon: 'i-lucide-settings-2' }
]

// Unified agent predicate. An agent row is any activity made by a
// non-human principal — the in-app AI loop ('ai') or MCP ('mcp').
// New rows carry an explicit `agentKind` (resolved server-side from
// `actor_principal`). The two `userName` fallbacks cover:
//   - 'AI Assistant' — historical AI rows from before the
//     actor_principal column landed.
//   - 'markoto' — comment-snapshot rows whose user_name is sourced
//     from the comment's authorName field. This path doesn't yet
//     propagate actor_principal (the comment-author is stored in
//     Y.js, not the JWT principal), so legacy detection by name is
//     still required. Same fallback for both AI + MCP comments,
//     which share `handleCreateComment`.
//   - 'MCP' — defensive fallback if an MCP row landed with
//     actor_principal somehow missing.
function isAgent(entry: ActivityEntry): boolean {
  if (entry.agentKind !== null) return true
  return entry.userName === 'AI Assistant'
    || entry.userName === 'markoto'
    || entry.userName === 'MCP'
}

/**
 * Display name for the row. For agent rows: prefer the resolved
 * initiator (the human who triggered) so the activity feed mirrors
 * what the live PresenceBar already shows ("Helping Joel"). Falls
 * back to the raw userName ('markoto' / 'MCP' / 'AI Assistant')
 * when the session was swept or the row pre-dates the join chain.
 */
function displayName(entry: ActivityEntry): string {
  if (entry.agentInitiatorName) return entry.agentInitiatorName
  return entry.userName ?? t('activity.anonymous')
}

/**
 * "via {label}" badge text for agent rows. Empty string for human
 * rows (no badge rendered).
 *   - MCP: `agentClientName` (which already coalesces to userAgent
 *     when the initialize-time clientInfo.name wasn't captured)
 *   - AI: a friendly literal — the in-app loop has no per-client
 *     distinction yet (someday: voice prompt vs comment trigger vs
 *     prompt bar)
 */
function agentBadgeText(entry: ActivityEntry): string {
  if (entry.agentKind === 'mcp') return entry.agentClientName ?? 'MCP'
  if (entry.agentKind === 'ai') return 'markoto AI'
  // Legacy AI rows (no actor_principal yet, detected by userName).
  // Don't show the "via" badge for those — we'd be inventing a
  // label, and the existing UX shows just "AI Assistant" / "markoto"
  // as the name. Once the migration backfills (or rows age out via
  // the 500-row cap), this branch goes away.
  return ''
}

// Per-row diff drawer expansion. Only `edit` rows are expandable in
// Phase 1 — comment / theme / title / ai.tool expansions land in
// follow-up phases. We gate the click handler on the action so a
// user clicking a non-expandable card doesn't appear to "miss" a
// click target. The Set holds activity ids; multiple cards can be
// open simultaneously (matches the stated UX — users compare diffs).
const expandedIds = ref<Set<number>>(new Set())

// Branching for expansion eligibility lives in the pure helper —
// see `app/utils/activityFeedHelpers.ts`. Keeps the SFC short AND
// gives us a single test target for "every action kind maps to the
// right behavior." This wrapper just adapts the shared type.
function isExpandable(entry: ActivityEntry): boolean {
  return _isExpandable(entry)
}

/**
 * Which expansion component to mount for a given entry. Drives the
 * `<component :is>` switch in the template — keeps the markup short.
 * Returns `[component, props]` so we can pass kind-specific props
 * (the AI-tool drawer reads from metadata, not the endpoint).
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
  // restore rows reuse the diff drawer — `restore` activity rows
  // carry yjsDocIdBefore/After (live state pre-restore vs post-
  // restore) so the existing /diff endpoint produces a meaningful
  // "what content was wiped / re-added" diff. No new component
  // needed; the same ActivityRowDiff that powers `edit` rows
  // does the work.
  if (entry.action === 'restore') {
    return { is: ActivityRowDiff, props: { docId: props.docId, activityId: entry.id } }
  }
  return null
}

/**
 * Per-kind label on the expansion-toggle affordance. Resolves the
 * i18n key returned by the shared helper through the SFC's `t()`.
 */
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

// --- Restore button + confirm modal -------------------------------
//
// "Restore to this point" appears on every row that has a usable
// `yjsDocIdBefore` boundary. Clicking opens a confirm modal; on
// confirm, the modal POSTs to the restore endpoint and emits a
// success event back here so we refetch the activity list.
//
// Read-only viewers (workspace `viewer` role, password-locked
// without edit, etc.) get NO button at all — the empty space matches
// the prompt-bar's hidden-not-disabled approach for the same reason
// (showing a disabled affordance suggests "you might have access" /
// teases an upgrade).

const restoreModalOpen = ref(false)
const restoreCandidate = ref<{ activityId: number, whenLabel: string } | null>(null)

function isRestorable(entry: ActivityEntry): boolean {
  // Need the boundary id to know what state to restore TO. Pre-Tier-1
  // rows (yjsDocIdBefore === null) are excluded — restoring them
  // would surface a 410 from the endpoint. Cleaner to hide the
  // button than show one that always errors.
  if (props.readOnly) return false
  if (entry.yjsDocIdBefore === null) return false
  // Don't show the button on a `restore` row pointing at the row
  // we're about to be looking at — but actually that's fine because
  // the restore IS reversible (clicking it goes back to the live
  // pre-restore state). Allow it.
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
  // The /restore endpoint produced a new `restore` activity row.
  // Polling would catch it within 30s, but we want snappy feedback —
  // refetch immediately. The Y.Doc itself updates via the WS broadcast
  // from Hocuspocus, so the editor body changes without us doing
  // anything.
  loadActivity()
}
</script>

<template>
  <div class="space-y-2">
    <!-- Filter chips. Hidden when the feed is empty so the empty
         state stays clean. -->
    <div
      v-if="!loading && entries.length > 0"
      class="flex flex-wrap gap-1 pb-1.5 border-b border-default/60"
    >
      <!-- Filter chips. Active state is a sumi-toned solid (sumi-200
           in light, sumi-800 in dark) — NOT shu, since shu is reserved
           for AI presence. The chip count moves to the editor's mono
           micro-meta register so the row reads like a colophon. -->
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

    <!-- Card style mirrors `CommentThread.vue:.comment-thread-card`
         exactly — same rounded-md border, same bg-default + shadow-sm,
         same hover transition. Keeps the two right-sidebar feeds
         (Comments + Activity) visually a single family.
         `edit` rows are clickable to expand a diff drawer; other
         action types aren't expandable yet (Phase 2 follow-ups). -->
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
        <!-- Avatar. Agents get the seal disc; humans their generated
           face (seeded by user id). Rows without an id (anonymous,
           deleted users) are seeded by their display name. -->
        <!-- markoto avatar — bone disc in light mode, dark disc in
           dark mode (matches the surrounding cards), seal centered.
           The seal stays shu in both modes; the ring around it is
           the brand chrome's neutral. Earlier this used inverse
           shading (sumi-950 in light, sumi-50 in dark) which made
           the seal disappear in dark mode. -->
        <!-- Agent rows (in-app AI loop OR MCP) get the seal-on-disc.
             The seal is the brand AI mark — same visual for both
             kinds. The differentiation between "AI loop" and "MCP"
             lives in the badge text below, not the avatar. -->
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
            <!-- "via {agent}" badge — mono micro-label, eyebrow shape.
                 Empty for human rows + legacy agent rows that pre-date
                 the actor_principal column. The presence of a non-empty
                 badge is what tells collaborators "this edit was made
                 through an agent, not directly by the human". -->
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
            <!-- Git-style diff badges (edits only). -->
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

          <!-- Detail line: comment body preview, ai tool query/url/prompt,
             title from→to. Italic, indented slightly so it reads as a
             "quoted excerpt" rather than a continuation of the action. -->
          <div
            v-if="detailFor(entry)"
            class="mt-1 text-xs text-default/80 italic break-words line-clamp-2"
            :title="detailFor(entry) || undefined"
          >
            {{ detailFor(entry) }}
          </div>

          <!-- Affordance row: expansion caret (left) + restore button
             (right, when applicable). Both ride on text-[11px] for
             visual weight parity. The restore button has @click.stop
             so it doesn't also toggle expansion. -->
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

      <!-- Per-kind expansion drawer. Mounts only when expanded so each
           lazy-loaded component (and its endpoint round-trip) only
           fires when the user actually asks. The dynamic
           `<component :is>` lets a single drawer slot serve every
           expansion kind without an explosion of v-if branches.
           Stop click propagation so clicks inside don't collapse
           the card. -->
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

    <!-- The document's plan hides activity older than its history window. -->
    <CommonPlanLimitNotice
      v-if="historyLimitedDays !== null"
      message-key="plan.notice.historyHidden"
      :params="{ days: historyLimitedDays }"
      data-testid="activity-history-limited"
    />

    <!-- Restore confirmation modal — single instance, content driven
         by `restoreCandidate` (set when a row's restore button is
         clicked). Mounts only when needed; lazy-loaded so the modal
         markup ships only on the first restore click. -->
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
