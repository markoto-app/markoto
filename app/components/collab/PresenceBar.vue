<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'
import type { ApiResponse } from '~/utils/api/client'
import { normalizeAwarenessUser } from '~~/shared/utils/documents/awarenessUser'

// Shows:
//   1. Live editors: full opacity, colored ring.
//   2. Offline workspace members with access: 50% opacity, no ring (fetched
//      only for workspace docs; standalone/anonymous docs show live only).
//
// Live entries are matched to the roster by userId, so a live roster member
// gets the colored ring and drops out of the offline list. Signed-in users
// outside the workspace (open-edit/open-view docs) render live-only with a
// "Guest" tooltip; anonymous editors stay "Anonymous".

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
  // Known: 'thinking' | 'tool' | 'editing' | 'done' | 'error'. Wider
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
}

type WorkspaceRole = 'admin' | 'editor' | 'viewer'

type RosterMember = ApiResponse<'/api/docs/:docId/members', 'get'>['members'][number]

interface OfflineEntry {
  kind: 'offline'
  userId: number
  name: string
  role: WorkspaceRole
  isDocOwner: boolean
}

type DisplayEntry = LiveEntry | OfflineEntry

const { user: sessionUser } = useUserSession()
const myUserId = computed(() => (sessionUser.value?.id ?? null) as number | null)

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
  const seenUserIds = new Set<number>()
  if (me !== null) seenUserIds.add(me)

  states.forEach((state, clientId) => {
    if (clientId === localId) return
    // Peers choose their own awareness payload, so normalise before rendering:
    // `color` lands in inline styles, `avatarSeed` seeds the avatar, and a
    // non-string name would crash `charAt`. The document composable also
    // normalises on receipt; this keeps the component safe on its own.
    const user: AwarenessUser | null = normalizeAwarenessUser(state?.user)
    if (!user) return
    // yCollab passes the JWT userId into `user.id` — numeric for real users,
    // absent for unauthenticated, also numeric for AI.
    const userId = parseUserIdFromAwareness(user.id)
    // Drop other tabs of the same human user (AI sessions and anonymous
    // users without a userId fall through).
    if (!user.isAI && userId !== null) {
      if (seenUserIds.has(userId)) return
      seenUserIds.add(userId)
    }
    result.push({
      kind: 'live',
      clientId,
      userId,
      user,
      isAI: !!user.isAI,
      aiSession: state.aiSession as AiSessionMeta | undefined,
      aiStatus: state.aiStatus as AiStatus | undefined
    })
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
  loadRoster()
})

onUnmounted(() => {
  props.awareness.off('change', updateLive)
})

watch(() => props.docId, () => loadRoster())

// Anyone in the roster who isn't live gets an offline entry. The local viewer
// never appears (their own presence is in the editor). Live entries come first.
const merged = computed<DisplayEntry[]>(() => {
  const liveUserIds = new Set<number>()
  for (const e of liveEntries.value) {
    if (e.userId !== null) liveUserIds.add(e.userId)
  }
  const me = myUserId.value
  const offline: OfflineEntry[] = roster.value
    .filter(m => !liveUserIds.has(m.userId) && m.userId !== me)
    .map(m => ({
      kind: 'offline',
      userId: m.userId,
      name: m.name,
      role: m.role,
      isDocOwner: m.isDocOwner
    }))
  return [...liveEntries.value, ...offline]
})

// Tooltip: live roster member "Alice Test — Editor"; live non-roster
// "Bob — Guest" ("Anonymous" if unauthenticated); AI helper uses the
// ai.helpingTooltip key; offline "Alice Test — Editor (offline)".
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
  if (e.kind === 'live' && e.isAI) {
    // Deliberately generic ("markoto is helping Joel — markoto is working…"):
    // what the AI reads or queries is private to whoever started it, so
    // awareness carries only the phase.
    const base = e.aiSession?.initiatorName
      ? t('ai.helpingTooltip', { name: e.aiSession.initiatorName })
      : e.user.name
    if (isActivePhase(e.aiStatus)) {
      return `${base} — ${t('ai.workingGeneric')}`
    }
    return base
  }
  if (e.kind === 'live') {
    // Match the live user to a roster row to surface the role.
    if (e.userId !== null) {
      const match = roster.value.find(m => m.userId === e.userId)
      if (match) return `${e.user.name} — ${roleLabel(match.role)}`
    }
    if (e.userId === null) return t('presence.anonymousEditor')
    return `${e.user.name} — ${t('presence.guest')}`
  }
  return `${e.name} — ${roleLabel(e.role)} (${t('presence.offline')})`
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
        :key="e.kind === 'live' ? `l-${e.clientId}` : `o-${e.userId}`"
        :text="tooltipFor(e)"
      >
        <!-- Live: colored ring + full opacity; offline: no ring, 50% opacity.
             `inline-flex` keeps wrappers inline even if the tooltip renders a block host. -->
        <div
          v-if="e.kind === 'live'"
          class="relative inline-flex rounded-full ring-2 shrink-0 transition-opacity duration-200"
          :class="{ 'ai-pulse': e.isAI && isActivePhase(e.aiStatus) }"
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

        <div
          v-else
          class="relative inline-flex rounded-full ring-2 ring-default shrink-0 opacity-50 transition-opacity duration-200"
        >
          <CommonUserAvatar
            :seed="avatarSeedFor({ id: e.userId })"
            :name="e.name"
            :size="24"
            class="grayscale"
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
