<script setup lang="ts">
// Duplicate a document in-place. Keeps the source's workspace (or
// personal placement) and inherits content, theme, access mode, and
// image assets. The duplicator becomes the new owner so the copy
// surfaces on their "Recent" list.
//
// Keeping the modal minimal — just a title input — because the
// "duplicate somewhere else" case is rare and can be handled by the
// Move flow after the copy lands.

const props = defineProps<{
  docId: string
  sourceTitle: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  duplicated: [docId: string]
}>()

const { t } = useI18n()
const toast = useToast()

const duplicating = ref(false)
const newTitle = ref('')

// Prefill "Copy of X" whenever the modal opens — mirrors how desktop
// Finder / Drive handle duplicates. Truncate to 255 to match the DB
// limit.
watch(open, (v) => {
  if (!v) return
  const base = `Copy of ${props.sourceTitle || 'Untitled'}`
  newTitle.value = base.length > 255 ? base.slice(0, 255) : base
})

async function handleDuplicate() {
  if (duplicating.value) return
  const title = newTitle.value.trim()
  if (title.length === 0) return
  duplicating.value = true
  try {
    const { docId: newDocId } = await $fetch<{ docId: string }>(
      `/api/docs/${props.docId}/duplicate`,
      { method: 'POST', body: { title } }
    )
    toast.add({
      title: t('duplicate.success'),
      description: t('duplicate.successDesc', { title }),
      icon: 'i-lucide-copy-check',
      color: 'success'
    })
    open.value = false
    emit('duplicated', newDocId)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('duplicate.failed'),
      description: err.data?.message || err.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    duplicating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('duplicate.title')"
  >
    <template #content>
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-copy"
              class="size-5 text-primary"
            />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">
              {{ t('duplicate.title') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('duplicate.description') }}
            </p>
          </div>
        </div>

        <div class="mb-4">
          <label
            for="duplicate-title-input"
            class="block text-sm font-medium mb-2"
          >
            {{ t('duplicate.titleLabel') }}
          </label>
          <UInput
            id="duplicate-title-input"
            v-model="newTitle"
            :placeholder="t('duplicate.titlePlaceholder')"
            size="md"
            class="w-full"
            :ui="{ base: 'w-full' }"
            maxlength="255"
            autofocus
            @keydown.enter="handleDuplicate"
          />
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="duplicating"
            data-testid="duplicate-cancel"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="duplicating"
            :disabled="newTitle.trim().length === 0"
            icon="i-lucide-copy"
            data-testid="duplicate-confirm"
            @click="handleDuplicate"
          >
            {{ t('duplicate.confirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
