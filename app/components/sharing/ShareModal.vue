<script setup lang="ts">
const props = defineProps<{
  docId: string
  isOwner: boolean
  currentAccessMode: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  updated: [accessMode: string]
}>()

const { t } = useI18n()
const { copy, copied } = useClipboard()

const accessMode = ref(props.currentAccessMode)
const password = ref('')
const saving = ref(false)
const settingPassword = ref(false)

// Keep local accessMode in sync if parent prop changes
watch(() => props.currentAccessMode, (v) => {
  accessMode.value = v
})

const accessOptions = [
  { value: 'open-edit', label: 'share.openEdit', icon: 'i-lucide-pencil' },
  { value: 'open-view', label: 'share.openView', icon: 'i-lucide-eye' },
  { value: 'password-protected', label: 'share.passwordProtected', icon: 'i-lucide-lock' }
]

const shareUrl = computed(() => {
  if (import.meta.client) {
    return `${window.location.origin}/d/${props.docId}`
  }
  return `/d/${props.docId}`
})

function copyLink() {
  copy(shareUrl.value)
}

async function saveAccessMode(mode: string) {
  if (mode === 'password-protected') {
    settingPassword.value = true
    accessMode.value = mode
    return
  }

  saving.value = true
  try {
    if (props.currentAccessMode === 'password-protected' && mode !== 'password-protected') {
      await $fetch(`/api/docs/${props.docId}/password`, {
        method: 'POST',
        body: { action: 'remove' }
      })
    }

    await $fetch(`/api/docs/${props.docId}/meta`, {
      method: 'PUT',
      body: { access_mode: mode }
    })
    accessMode.value = mode
    emit('updated', mode)
  } catch (e: any) {
    console.error('Failed to update access mode:', e)
  } finally {
    saving.value = false
  }
}

async function setPassword() {
  if (!password.value || password.value.length < 4) return

  saving.value = true
  try {
    await $fetch(`/api/docs/${props.docId}/password`, {
      method: 'POST',
      body: { action: 'set', password: password.value }
    })
    settingPassword.value = false
    password.value = ''
    emit('updated', 'password-protected')
  } catch (e: any) {
    console.error('Failed to set password:', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('share.title')" :description="shareUrl">
    <template #content>
      <div class="p-6 space-y-5">
        <h3 class="text-lg font-semibold">{{ t('share.title') }}</h3>

        <!-- Copy link -->
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('share.copyLink') }}</label>
          <div class="flex gap-2">
            <UInput
              :model-value="shareUrl"
              readonly
              class="flex-1"
              size="sm"
            />
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="solid"
              size="sm"
              @click="copyLink"
            >
              {{ copied ? t('share.linkCopied') : t('share.copyLink') }}
            </UButton>
          </div>
        </div>

        <!-- Access mode (owner only) -->
        <div v-if="isOwner">
          <label class="block text-sm font-medium mb-2">{{ t('share.accessMode') }}</label>
          <div class="space-y-2">
            <button
              v-for="opt in accessOptions"
              :key="opt.value"
              class="w-full flex items-center gap-3 p-3 rounded-lg border transition-colors"
              :class="accessMode === opt.value
                ? 'border-primary bg-primary/5'
                : 'border-default hover:border-muted'"
              :disabled="saving"
              @click="saveAccessMode(opt.value)"
            >
              <UIcon :name="opt.icon" class="size-5 shrink-0" />
              <div class="text-left">
                <div class="text-sm font-medium">{{ t(opt.label) }}</div>
              </div>
              <UIcon
                v-if="accessMode === opt.value"
                name="i-lucide-check"
                class="size-4 ml-auto text-primary"
              />
            </button>
          </div>

          <!-- Password input -->
          <div v-if="settingPassword" class="mt-3 p-3 rounded-lg border border-default bg-[var(--ui-bg-muted)]">
            <label class="block text-sm font-medium mb-2">{{ t('share.setPassword') }}</label>
            <div class="flex gap-2">
              <UInput
                v-model="password"
                type="password"
                :placeholder="t('share.passwordPlaceholder')"
                size="sm"
                class="flex-1"
                @keydown.enter="setPassword"
              />
              <UButton
                size="sm"
                :loading="saving"
                :disabled="!password || password.length < 4"
                @click="setPassword"
              >
                {{ t('common.save') }}
              </UButton>
            </div>
            <p class="text-xs text-muted mt-1">{{ t('share.passwordMinLength') }}</p>
          </div>
        </div>

        <!-- Non-owner: just show current mode -->
        <div v-else>
          <label class="block text-sm font-medium mb-2">{{ t('share.accessMode') }}</label>
          <UBadge variant="subtle" size="md">
            <UIcon :name="accessOptions.find(o => o.value === accessMode)?.icon || 'i-lucide-globe'" class="size-3.5 mr-1" />
            {{ t(accessOptions.find(o => o.value === accessMode)?.label || 'share.openEdit') }}
          </UBadge>
        </div>

        <!-- Close -->
        <div class="flex justify-end pt-2">
          <UButton variant="ghost" @click="open = false">
            {{ t('common.close') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
