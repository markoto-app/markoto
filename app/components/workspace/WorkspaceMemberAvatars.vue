<script setup lang="ts">
// Static avatar stack for workspace members. Visually echoes PresenceBar
// but doesn't tail awareness — the data is the persistent member list,
// not live presence. Clicking the bar opens the manage-members modal.

export interface WorkspaceMember {
  userId: number
  name: string
  email: string | null
  login: string | null
  avatarUrl: string | null
  role: 'admin' | 'editor' | 'viewer'
}

const props = defineProps<{
  members: WorkspaceMember[]
  max?: number
}>()

const emit = defineEmits<{
  click: []
}>()

const max = computed(() => props.max ?? 5)
const visible = computed(() => props.members.slice(0, max.value))
const overflow = computed(() => Math.max(0, props.members.length - max.value))

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w.charAt(0).toUpperCase())
    .join('')
}

// Same palette the doc editor uses to tint anonymous collaborators. Sticking
// to this keeps avatar colors stable + recognizable across app surfaces.
const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316']
function colorFor(userId: number) {
  return colors[Math.abs(userId) % colors.length]
}

function tooltipFor(m: WorkspaceMember) {
  const roleLabel = m.role === 'admin' ? ' (Admin)' : m.role === 'viewer' ? ' (Viewer)' : ''
  return `${m.name}${roleLabel}`
}
</script>

<template>
  <button
    type="button"
    class="group flex items-center gap-1.5 rounded-full px-1 py-0.5 hover:bg-muted/50 transition-colors"
    @click="emit('click')"
  >
    <div class="flex -space-x-1.5">
      <UTooltip
        v-for="m in visible"
        :key="m.userId"
        :text="tooltipFor(m)"
      >
        <div class="relative rounded-full ring-2 ring-default shrink-0">
          <UAvatar
            v-if="m.avatarUrl"
            :src="m.avatarUrl"
            :alt="m.name"
            size="xs"
          />
          <div
            v-else
            class="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            :style="{ backgroundColor: colorFor(m.userId) }"
          >
            {{ initials(m.name) }}
          </div>
        </div>
      </UTooltip>
    </div>
    <span v-if="overflow > 0" class="text-xs text-muted">+{{ overflow }}</span>
  </button>
</template>
