<script setup lang="ts">
// Grid of workspace cards for the dashboard.
import type { ApiResponse } from '~/utils/api/client'

/** Card row payload from `/api/user/workspaces`. */
export type WorkspaceListItem = ApiResponse<'/api/user/workspaces', 'get'>[number]

defineProps<{
  workspaces: WorkspaceListItem[]
  loading?: boolean
}>()

const { t, locale } = useI18n()

function formatDate(value: string | number | Date | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(locale.value, { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <!-- Loading indicator. Same `i-lucide-loader` size-8 + text-primary
       (= shu) treatment as the editor's `pages/d/[id].vue:14` so the
       spinner reads identically across all loading surfaces in the
       app. -->
  <div
    v-if="loading"
    class="flex justify-center py-6"
  >
    <UIcon
      name="i-lucide-loader"
      class="size-6 animate-spin text-primary mx-auto"
    />
  </div>
  <div
    v-else-if="workspaces.length > 0"
    class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3"
  >
    <NuxtLink
      v-for="ws in workspaces"
      :key="ws.workspaceId"
      :to="`/w/${ws.workspaceId}`"
      :data-testid="`workspace-list-item-${ws.workspaceId}`"
      :data-role="ws.role"
      class="group flex flex-col gap-2 p-4 rounded-lg border border-default hover:border-default hover:bg-muted/40 transition-colors min-w-0"
    >
      <div class="flex items-start gap-3 min-w-0">
        <div class="size-9 rounded-md bg-elevated flex items-center justify-center shrink-0">
          <UIcon
            name="i-lucide-folder"
            class="size-5 text-toned"
          />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <p class="font-serif text-base font-normal tracking-tight truncate">{{ ws.name }}</p>
            <UBadge
              v-if="ws.role !== 'admin'"
              size="xs"
              color="neutral"
              variant="subtle"
              class="shrink-0"
            >
              {{ ws.role === 'editor' ? t('workspace.roles.editor') : t('workspace.roles.viewer') }}
            </UBadge>
          </div>
          <p
            v-if="ws.description"
            class="text-xs text-muted line-clamp-2 mt-0.5"
          >
            {{ ws.description }}
          </p>
        </div>
      </div>
      <div class="flex items-center justify-between text-xs text-muted mt-auto pt-1">
        <span>{{ t('workspace.docCount', { count: ws.docCount }, ws.docCount) }}</span>
        <span v-if="ws.lastActive">{{ formatDate(ws.lastActive) }}</span>
        <span v-else>{{ formatDate(ws.createdAt) }}</span>
      </div>
    </NuxtLink>
  </div>
  <p
    v-else
    class="text-sm text-muted"
  >
    {{ t('workspace.noWorkspaces') }}
  </p>
</template>
