<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'

// Presence bar shows:
//   1. Live editors — currently connected, full opacity, colored ring.
//   2. Offline workspace members with access — 50% opacity, no color ring.
//      Clicking (or letting them come online) flips to full opacity with a
//      CSS transition. Only fetched for workspace docs; standalone/anon docs
//      show only live presence (the classic behavior).
//
// Live entries are matched to roster entries by userId — a live user who's
// also in the roster renders with the colored awareness ring AND is removed
// from the offline list. Logged-in guests not in the workspace (reaching the
// doc via open-edit/open-view) render as live-only with a "Guest" tooltip.
// Anonymous editors stay "Anonymous".

const props = defineProps<{
  awareness: Awareness
  docId: string
}>()

const { t } = useI18n()

interface AwarenessUser {
  name: string
  color: string
  avatar?: string
  isAI?: boolean
  id?: number | string    // yCollab seeds this from the JWT userId
}

interface AiSessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  prompt?: string
}

interface AiStatus {
  phase: 'thinking' | 'tool' | 'editing' | 'done' | 'error' | string
  message: string | null
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

interface RosterMember {
  userId: number
  name: string
  avatarUrl: string | null
  role: 'admin' | 'editor' | 'viewer'
  isDocOwner: boolean
}

interface OfflineEntry {
  kind: 'offline'
  userId: number
  name: string
  avatarUrl: string | null
  role: 'admin' | 'editor' | 'viewer'
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
  const result: LiveEntry[] = []

  states.forEach((state, clientId) => {
    if (clientId === localId) return
    if (!state?.user) return
    const user = state.user as AwarenessUser
    // yCollab passes the JWT userId into `user.id` — numeric for real users,
    // string 'anonymous' for unauthenticated, also numeric for AI.
    const raw = user.id
    const userId = typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw)
        : null
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
    const res = await $fetch<{ members: RosterMember[] }>(`/api/docs/${props.docId}/members`)
    roster.value = res.members
  } catch {
    // Silent — non-member fetchers get an empty array anyway. A failure just
    // means we fall back to "live only" display, which is the old behavior.
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

// Merge: anyone in the roster who isn't currently live gets an offline
// entry. The local viewer themselves never appears — they already see their
// own awareness in the editor, and listing themselves as "offline" in their
// own doc would be bizarre. Live entries (filtered server-side by the
// awareness `clientID === localID` check) come first; offline roster after.
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
      avatarUrl: m.avatarUrl,
      role: m.role,
      isDocOwner: m.isDocOwner
    }))
  return [...liveEntries.value, ...offline]
})

// Tooltip content:
//   - Live + in-roster: "Alice Test — Editor" (role from the roster)
//   - Live + not in roster: "Bob — Guest" (or "Anonymous" if unauthenticated)
//   - AI helper: delegated to the existing ai.helpingTooltip i18n key
//   - Offline: "Alice Test — Editor (offline)"
function roleLabel(role: 'admin' | 'editor' | 'viewer') {
  return role === 'admin' ? t('workspace.roles.admin')
    : role === 'editor' ? t('workspace.roles.editor')
      : t('workspace.roles.viewer')
}

function tooltipFor(e: DisplayEntry): string {
  if (e.kind === 'live' && e.isAI) {
    // Build "Helping Joel — <current status>" so collaborators watching
    // someone else's AI session can see *what* it's doing at a glance
    // (fetching a URL, updating the theme, etc.). The status message
    // is produced by `describeToolInput` on the server side.
    const base = e.aiSession?.initiatorName
      ? t('ai.helpingTooltip', { name: e.aiSession.initiatorName })
      : e.user.name
    const status = e.aiStatus
    if (status && isActivePhase(status) && status.message) {
      return `${base} — ${status.message}`
    }
    return base
  }
  if (e.kind === 'live') {
    // Try to match live user to a roster row by userId to surface the role.
    if (e.userId !== null) {
      const match = roster.value.find(m => m.userId === e.userId)
      if (match) return `${e.user.name} — ${roleLabel(match.role)}`
    }
    if (e.userId === null) return t('presence.anonymousEditor')
    return `${e.user.name} — ${t('presence.guest')}`
  }
  // offline
  return `${e.name} — ${roleLabel(e.role)} (${t('presence.offline')})`
}

function isActivePhase(status: AiStatus | undefined): boolean {
  if (!status) return false
  return status.phase !== 'done' && status.phase !== 'error'
}

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('')
}

const offlineColors = ['#64748b', '#71717a'] // muted slate + zinc, role-neutral
function offlineBg(userId: number) {
  return offlineColors[Math.abs(userId) % offlineColors.length]
}
</script>

<template>
  <div
    v-if="merged.length > 0"
    class="flex items-center gap-1.5"
  >
    <div class="flex -space-x-1.5">
      <UTooltip
        v-for="e in merged.slice(0, 7)"
        :key="e.kind === 'live' ? `l-${e.clientId}` : `o-${e.userId}`"
        :text="tooltipFor(e)"
      >
        <!-- Live: colored ring + full opacity. Offline: no ring, 50% opacity. -->
        <div
          v-if="e.kind === 'live'"
          class="relative rounded-full ring-2 shrink-0 transition-opacity duration-200"
          :class="{ 'ai-pulse': e.isAI && isActivePhase(e.aiStatus) }"
          :style="{ '--tw-ring-color': e.user.color }"
        >
          <UAvatar
            v-if="e.user.avatar && !e.isAI"
            :src="e.user.avatar"
            :alt="e.user.name"
            size="xs"
            referrerpolicy="no-referrer"
          />
          <div
            v-else
            class="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            :style="{ backgroundColor: e.user.color }"
          >
            <UIcon
              v-if="e.isAI"
              name="i-lucide-sparkles"
              class="size-3.5"
            />
            <span v-else>{{ e.user.name.charAt(0).toUpperCase() }}</span>
          </div>
        </div>

        <div
          v-else
          class="relative rounded-full ring-2 ring-default shrink-0 opacity-50 transition-opacity duration-200"
        >
          <UAvatar
            v-if="e.avatarUrl"
            :src="e.avatarUrl"
            :alt="e.name"
            size="xs"
            class="grayscale"
            referrerpolicy="no-referrer"
          />
          <div
            v-else
            class="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            :style="{ backgroundColor: offlineBg(e.userId) }"
          >
            {{ initialsOf(e.name) }}
          </div>
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
/* Gentle pulse to signal an active AI session */
.ai-pulse {
  animation: ai-ring-pulse 1.6s ease-in-out infinite;
}
@keyframes ai-ring-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--tw-ring-color); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--tw-ring-color) 30%, transparent); }
}
</style>
