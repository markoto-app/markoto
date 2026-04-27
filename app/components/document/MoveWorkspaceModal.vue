<script setup lang="ts">
// Move a document into, between, or out of a workspace. Only
// workspaces where the user is admin/editor show up as targets —
// viewer workspaces would reject the move on the server anyway.

interface WorkspaceOption {
  workspaceId: string
  name: string
  role: 'admin' | 'editor' | 'viewer'
}

const props = defineProps<{
  docId: string
  docTitle: string
  // Current workspace assignment of the doc. Null = personal.
  currentWorkspaceId: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  moved: [workspaceId: string | null]
}>()

const { t } = useI18n()
const toast = useToast()

const saving = ref(false)

// Null represents "Personal" (no workspace). We use null explicitly
// in the selection to distinguish "unpicked" from "pick Personal".
const selected = ref<string | null>(null)

const {
  state: workspaces,
  isLoading: loadingWorkspaces,
  execute: loadWorkspaces
} = useAsyncState<WorkspaceOption[]>(
  async () => {
    const rows = await $fetch<WorkspaceOption[]>('/api/user/workspaces')
    // Only admin/editor can receive a doc — filter viewer-only workspaces
    // out so the user can't pick something the server would reject.
    return rows.filter(w => w.role === 'admin' || w.role === 'editor')
  },
  [],
  {
    immediate: false,
    resetOnExecute: false,
    onError: () => { workspaces.value = [] }
  }
)

watch(open, (v) => {
  if (!v) return
  selected.value = props.currentWorkspaceId
  loadWorkspaces()
})

const hasChange = computed(() => selected.value !== props.currentWorkspaceId)

async function handleMove() {
  if (saving.value || !hasChange.value) return
  saving.value = true
  try {
    await $fetch(`/api/docs/${props.docId}/workspace`, {
      method: 'PATCH',
      body: { workspaceId: selected.value }
    })
    toast.add({
      title: t('move.success'),
      description: selected.value === null
        ? t('move.successToPersonal', { title: props.docTitle })
        : t('move.successToWorkspace', {
            title: props.docTitle,
            workspace: workspaces.value.find(w => w.workspaceId === selected.value)?.name ?? ''
          }),
      icon: 'i-lucide-folder-input',
      color: 'success'
    })
    open.value = false
    emit('moved', selected.value)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('move.failed'),
      description: err.data?.message || err.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('move.title')"
  >
    <template #content>
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-folder-input"
              class="size-5 text-primary"
            />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">
              {{ t('move.title') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('move.description') }}
            </p>
          </div>
        </div>

        <div class="mb-4">
          <p class="text-sm text-muted mb-2">
            {{ t('move.document') }}:
            <span class="font-medium text-default">{{ docTitle || t('workspace.untitledDoc') }}</span>
          </p>

          <div
            v-if="loadingWorkspaces"
            class="flex items-center gap-2 py-3 text-sm text-muted"
          >
            <UIcon
              name="i-lucide-loader"
              class="size-4 animate-spin"
            />
            {{ t('common.loading') }}
          </div>

          <div
            v-else
            class="space-y-1 border border-default rounded-lg max-h-72 overflow-y-auto"
          >
            <!-- Personal (null) is always an option — detaches from
                 any workspace. -->
            <button
              type="button"
              class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated transition-colors"
              :class="selected === null ? 'bg-primary/10' : ''"
              @click="selected = null"
            >
              <UIcon
                name="i-lucide-user"
                class="size-4 text-muted"
              />
              <span class="flex-1 text-sm font-medium">{{ t('move.personal') }}</span>
              <UIcon
                v-if="selected === null"
                name="i-lucide-check"
                class="size-4 text-primary"
              />
            </button>
            <template v-if="workspaces.length > 0">
              <div class="border-t border-default" />
              <button
                v-for="ws in workspaces"
                :key="ws.workspaceId"
                type="button"
                class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated transition-colors"
                :class="selected === ws.workspaceId ? 'bg-primary/10' : ''"
                @click="selected = ws.workspaceId"
              >
                <UIcon
                  name="i-lucide-folder"
                  class="size-4 text-muted"
                />
                <span class="flex-1 text-sm font-medium">{{ ws.name }}</span>
                <UBadge
                  v-if="ws.role !== 'admin'"
                  size="xs"
                  color="neutral"
                  variant="subtle"
                >
                  {{ t(`workspace.roles.${ws.role}`) }}
                </UBadge>
                <UIcon
                  v-if="selected === ws.workspaceId"
                  name="i-lucide-check"
                  class="size-4 text-primary"
                />
              </button>
            </template>
          </div>

          <p
            v-if="!loadingWorkspaces && workspaces.length === 0"
            class="text-xs text-muted mt-2"
          >
            {{ t('move.noWorkspaces') }}
          </p>
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="saving"
            :disabled="!hasChange"
            icon="i-lucide-folder-input"
            @click="handleMove"
          >
            {{ t('move.confirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
