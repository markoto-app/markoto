<script setup lang="ts">
import type { ExplorerItem } from '~/utils/explorer/model'

// Delete confirmation naming what goes: for folders, everything inside
// (subfolders and documents, counted by the server), so nobody deletes a
// tree of 300 documents by accident. When some documents inside may not be
// deleted by this person, it says how many and offers no delete.

const props = defineProps<{ items: readonly ExplorerItem[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [] }>()

const { t } = useI18n()
const counts = ref<{ folders: number, documents: number, blocked: number } | null>(null)
const loading = ref(false)
const failed = ref(false)

watch(open, async (v) => {
  if (!v) return
  counts.value = null
  failed.value = false
  const folderItems = props.items.filter(i => i.kind === 'folder')
  const docs = props.items.length - folderItems.length
  let folders = 0
  let documents = docs
  let blocked = 0
  loading.value = folderItems.length > 0
  try {
    for (const f of folderItems) {
      const p = await apiFetch('/api/folders/:folderId/delete-preview', { path: { folderId: f.id } })
      folders += p.folders
      documents += p.documents
      blocked += p.blocked
    }
    counts.value = { folders, documents, blocked }
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}, { immediate: true })

const title = computed(() => props.items.length === 1 ? props.items[0]?.label ?? '' : t('explorer.delete.items', { n: props.items.length }, props.items.length))
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('explorer.delete.title')"
  >
    <template #body>
      <div
        class="space-y-3 text-sm"
        data-testid="explorer-delete-dialog"
      >
        <p>{{ t('explorer.delete.question', { name: title }) }}</p>
        <p
          v-if="loading"
          class="text-muted"
        >
          {{ t('explorer.delete.counting') }}
        </p>
        <p
          v-else-if="counts"
          data-testid="explorer-delete-counts"
        >
          {{ t('explorer.delete.counts', { folders: t('explorer.delete.folderCount', { n: counts.folders }, counts.folders), documents: t('explorer.delete.documentCount', { n: counts.documents }, counts.documents) }) }}
        </p>
        <UAlert
          v-if="counts && counts.blocked > 0"
          color="error"
          variant="subtle"
          icon="i-lucide-lock"
          :description="t('explorer.delete.blocked', { n: counts.blocked }, counts.blocked)"
        />
        <p class="text-muted">
          {{ t('explorer.delete.permanent') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="error"
          :disabled="loading || failed || !counts || counts.blocked > 0"
          data-testid="explorer-delete-confirm"
          @click="emit('confirm')"
        >
          {{ t('explorer.delete.confirm') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
