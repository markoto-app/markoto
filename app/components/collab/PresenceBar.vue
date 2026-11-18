<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'
import type { ApiResponse } from '~/utils/api/client'
import { normalizeAwarenessUser } from '~~/shared/utils/documents/awarenessUser'

// Shows only the people who have this document open right now (colored
// ring). A live editor whose tab is hidden (`away` in their awareness
// state, see utils/collab/hiddenTabPause.ts) is dimmed and marked away.
// Members who could open it but don't are not listed.
//
// The workspace roster (fetched for workspace docs only) just labels a live
// member with their role. Signed-in users outside the workspace
// (open-edit/open-view docs) get a "Guest" tooltip; anonymous editors stay
// "Anonymous".

const props = defineProps<{
  awareness: Awareness
  docId: string
}>()

const { t } = useI18n()

interface AwarenessUser {
  name: string
  color: string
  avatarSeed?: string // anonymous visitors' random per-tab token
  isAI?: boolean
  id?: number // seeded from the session user id; absent for anonymous
}

interface AiSessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
}

interface AiStatus {
  // Known: 'thinking' | 'tool' | 'editing' | 'done' | 'error' | 'job'. Wider
  // string accepts upstream additions without the union drifting.
  phase: string
}

interface LiveEntry {
  kind: 'live'
  clientId: number
  userId: number | null
  user: AwarenessUser
  isAI: boolean
  aiSession?: AiSessionMeta
  aiStatus?: AiStatus
  away: boolean
}

type WorkspaceRole = 'admin' | 'editor' | 'viewer'

type RosterMember = ApiResponse<'/api/docs/:docId/members', 'get'>['members'][number]

type DisplayEntry = LiveEntry

const { user: sessionUser } = useUserSession()
const myUserId = computed(() => sessionUser.value?.id ?? null)

const liveEntries = ref<LiveEntry[]>([])
const roster = ref<RosterMember[]>([])

function updateLive() {
  const states = props.awareness.getStates()
  const localId = props.awareness.clientID
  const me = myUserId.value
  const result: LiveEntry[] = []
  // Dedup by userId across the whole awareness set so a second tab of the same
  // signed-in user doesn't add a second avatar. Anonymous entries (no userId)
  // and AI sessions are never deduplicated: each is a distinct presence.
  // A person counts as away only when every one of their tabs is.
  const seenUserIds = new Set<number>()
  if (me !== null) seenUserIds.add(me)
  const entryByUserId = new Map<number, LiveEntry>()

  states.forEach((state, clientId) => {
    if (clientId === localId) return
    // Peers choose their own awareness payload, so normalise before rendering:
    // `color` lands in inline styles, `avatarSeed` seeds the avatar, and a
    // non-string name would crash `charAt`. The document composable also
    // normalises on receipt; this keeps the component safe on its own.
    const user: AwarenessUser | null = normalizeAwarenessUser(state?.user)
    if (!user) return
    // yCollab passes the JWT userId into `user.id`, numeric for real users,
    // absent for unauthenticated, also numeric for AI.
    const userId = parseUserIdFromAwareness(user.id)
    // Drop other tabs of the same human user (AI sessions and anonymous
    // users without a userId fall through).
    const away = state.away === true
    if (!user.isAI && userId !== null) {
      if (seenUserIds.has(userId)) {
        const seen = entryByUserId.get(userId)
        if (seen && !away) seen.away = false
        return
      }
      seenUserIds.add(userId)
    }
    const entry: LiveEntry = {
      kind: 'live',
      clientId,
      userId,
      user,
      isAI: !!user.isAI,
      aiSession: state.aiSession as AiSessionMeta | undefined,
      aiStatus: state.aiStatus as AiStatus | undefined,
      away
    }
    if (!user.isAI && userId !== null) entryByUserId.set(userId, entry)
    result.push(entry)
  })
  liveEntries.value = result
}

async function loadRoster() {
  try {
    const res = await apiFetch('/api/docs/:docId/members', { path: { docId: props.docId } })
    roster.value = res.members
  } catch {
    // Non-member fetchers get an empty array anyway; a failure falls back to live-only display.
    roster.value = []
  }
}

onMounted(() => {
  updateLive()
  props.awareness.on('change', updateLive)
  void loadRoster()
})

onUnmounted(() => {
  props.awareness.off('change', updateLive)
})

watch(() => props.docId, () => loadRoster())

// The local viewer never appears (their own presence is in the editor).
const merged = computed<DisplayEntry[]>(() => liveEntries.value)

// Tooltip: live roster member "Alice Test · Editor"; live non-roster
// "Bob · Guest" ("Anonymous" if unauthenticated); AI helper uses the
// ai.helpingTooltip key.
function roleLabel(role: WorkspaceRole) {
  if (role === 'admin') return t('workspace.roles.admin')
  if (role === 'editor') return t('workspace.roles.editor')
  return t('workspace.roles.viewer')
}

function parseUserIdFromAwareness(raw: unknown): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw)
  return null
}

function tooltipFor(e: DisplayEntry): string {
  if (e.isAI) {
    // Deliberately generic ("markoto is helping Joel, markoto is working…"):
    // what the AI reads or queries is private to whoever started it, so
    // awareness carries only the phase.
    const base = e.aiSession?.initiatorName
      ? t('ai.helpingTooltip', { name: e.aiSession.initiatorName })
      : e.user.name
    if (isActivePhase(e.aiStatus)) {
      return `${base}: ${t('ai.workingGeneric')}`
    }
    return base
  }
  const away = e.away ? ` (${t('presence.away')})` : ''
  return `${liveHumanLabel(e)}${away}`
}

function liveHumanLabel(e: LiveEntry): string {
  if (e.userId === null) return t('presence.anonymousEditor')
  // Match the live user to a roster row to surface the role.
  const match = roster.value.find(m => m.userId === e.userId)
  if (match) return `${e.user.name} · ${roleLabel(match.role)}`
  return `${e.user.name} · ${t('presence.guest')}`
}

function isActivePhase(status: AiStatus | undefined): boolean {
  if (!status) return false
  return status.phase !== 'done' && status.phase !== 'error'
}

function liveSeed(e: LiveEntry): string {
  // Signed-in: by user id (same face as in comments, members, …).
  // Anonymous: the visitor's random session token; a peer on an old
  // client without one still gets a stable face per connection.
  return avatarSeedFor({ id: e.userId, avatarSeed: e.user.avatarSeed, fallback: e.clientId })
}
</script>

<template>
  <!-- flex-row + flex-nowrap are pinned: UTooltip's Reka Slot host can change
       layout between Nuxt UI versions, which once stacked the avatars vertically. -->
  <div
    v-if="merged.length > 0"
    class="flex flex-row flex-nowrap items-center gap-1.5"
  >
    <div class="flex flex-row flex-nowrap -space-x-1.5">
      <UTooltip
        v-for="e in merged.slice(0, 7)"
        :key="`l-${e.clientId}`"
        :text="tooltipFor(e)"
      >
        <!-- Colored ring; dimmed while the tab is hidden.
             `inline-flex` keeps wrappers inline even if the tooltip renders a block host. -->
        <div
          class="relative inline-flex rounded-full ring-2 shrink-0 transition-opacity duration-200"
          :class="{ 'ai-pulse': e.isAI && isActivePhase(e.aiStatus), 'opacity-60': e.away }"
          :data-away="e.away ? 'true' : undefined"
          :style="{ '--tw-ring-color': e.user.color }"
        >
          <!-- markoto presence: seal on a `bg-default` disc; humans get their generated face. -->
          <div
            v-if="e.isAI"
            class="size-6 rounded-full flex items-center justify-center bg-default border border-default"
          >
            <CommonSeal :size="8" />
          </div>
          <CommonUserAvatar
            v-else
            :seed="liveSeed(e)"
            :name="e.user.name"
            :size="24"
          />
        </div>
      </UTooltip>
    </div>
    <span
      v-if="merged.length > 7"
      class="text-xs text-muted"
    >
      +{{ merged.length - 7 }}
    </span>
  </div>
</template>

<style scoped>
/* Pulse for an active AI session */
.ai-pulse {
  animation: ai-ring-pulse 1.6s ease-in-out infinite;
}
@keyframes ai-ring-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--tw-ring-color); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--tw-ring-color) 30%, transparent); }
}
</style>
