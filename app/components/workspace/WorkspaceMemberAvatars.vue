<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'

// Workspace member roster. Up to THRESHOLD members render as rows (avatar,
// name, role caption); beyond that it falls back to a compact avatar stack
// so the header doesn't grow unbounded. Both modes have an explicit "Manage
// members" pill, since the avatar group alone doesn't read as clickable.

export type WorkspaceMember = ApiResponse<'/api/workspaces/:wsId', 'get'>['members'][number]

const props = defineProps<{
  members: WorkspaceMember[]
  max?: number
}>()

const emit = defineEmits<{
  click: []
}>()

const { t } = useI18n()

// Threshold below which we render the expanded roster. 6 fits a
// small/medium team comfortably without making the header tall;
// above it we collapse to the avatar stack.
const ROW_THRESHOLD = 6
const expanded = computed(() => props.members.length <= ROW_THRESHOLD)

const max = computed(() => props.max ?? 5)
const visible = computed(() => props.members.slice(0, max.value))
const overflow = computed(() => Math.max(0, props.members.length - max.value))

function roleLabel(role: WorkspaceMember['role']): string {
  // Localized via the existing workspace.roles namespace; admin
  // renders as "Admin", editor as "Editor", viewer as "Viewer".
  return t(`workspace.roles.${role}`)
}
</script>

<template>
  <!-- Expanded roster — one row per member with avatar + name + role
       caption (mono micro-meta). The "Manage members" button on the
       right makes the edit affordance obvious. -->
  <div
    v-if="expanded"
    class="space-y-2"
  >
    <button
      type="button"
      class="group w-full text-left flex items-center justify-between gap-3 rounded-md p-1.5 -m-1.5 hover:bg-default transition-colors"
      :title="t('workspace.members.manage')"
      data-testid="workspace-members-trigger"
      @click="emit('click')"
    >
      <div class="flex flex-col gap-1.5 min-w-0">
        <div
          v-for="m in members"
          :key="m.userId"
          class="flex items-center gap-2.5 min-w-0"
        >
          <CommonUserAvatar
            :seed="avatarSeedFor({ id: m.userId })"
            :size="20"
          />
          <span class="text-sm text-default truncate">{{ m.name }}</span>
          <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase shrink-0">{{ roleLabel(m.role) }}</span>
        </div>
      </div>
      <span class="inline-flex items-center gap-1.5 self-start font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase shrink-0 group-hover:text-default transition-colors">
        <UIcon
          name="i-lucide-pencil"
          class="size-3"
        />
        {{ t('workspace.members.manage') }}
      </span>
    </button>
  </div>

  <!-- Compact avatar stack — used once the roster grows past
       ROW_THRESHOLD members. Same explicit "Manage members" pill so
       the edit affordance is still obvious even when the avatars
       carry the visual weight. -->
  <div
    v-else
    class="flex items-center gap-3 flex-wrap"
  >
    <button
      type="button"
      class="group flex items-center gap-1.5 rounded-full px-1 py-0.5 hover:bg-default transition-colors"
      :title="t('workspace.members.manage')"
      @click="emit('click')"
    >
      <div class="flex -space-x-1.5">
        <UTooltip
          v-for="m in visible"
          :key="m.userId"
          :text="`${m.name} · ${roleLabel(m.role)}`"
        >
          <div class="relative rounded-full ring-2 ring-default shrink-0">
            <CommonUserAvatar
              :seed="avatarSeedFor({ id: m.userId })"
              :name="m.name"
              :size="24"
            />
          </div>
        </UTooltip>
      </div>
      <span
        v-if="overflow > 0"
        class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
      >+{{ overflow }}</span>
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.04em] text-muted hover:text-default lowercase transition-colors"
      @click="emit('click')"
    >
      <UIcon
        name="i-lucide-pencil"
        class="size-3"
      />
      {{ t('workspace.members.manage') }}
    </button>
  </div>
</template>
