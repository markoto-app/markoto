<script setup lang="ts">
const props = defineProps<{
  docId: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  verified: [token: string]
  cancel: []
}>()

const { t } = useI18n()
const password = ref('')
const error = ref('')
const loading = ref(false)

async function verify() {
  if (!password.value) return

  loading.value = true
  error.value = ''

  try {
    const result = await $fetch<{ success: boolean; token: string; readOnly: boolean }>(
      `/api/docs/${props.docId}/password`,
      {
        method: 'POST',
        body: { action: 'verify', password: password.value }
      }
    )
    emit('verified', result.token)
  } catch (e: any) {
    error.value = e.data?.message || t('share.invalidPassword')
    password.value = ''
  } finally {
    loading.value = false
  }
}

function handleClose() {
  emit('cancel')
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('share.passwordRequired')"
    :close="false"
    @update:open="(val: boolean) => { if (!val) handleClose() }"
  >
    <template #content>
      <div class="p-6">
        <div class="text-center mb-5">
          <div class="mx-auto mb-3 size-12 rounded-full bg-amber-500/10 flex items-center justify-center">
            <UIcon name="i-lucide-lock" class="size-6 text-amber-500" />
          </div>
          <h2 class="text-lg font-semibold">{{ t('share.passwordRequired') }}</h2>
          <p class="text-sm text-muted mt-1">{{ t('share.passwordRequiredDesc') }}</p>
        </div>

        <form @submit.prevent="verify">
          <UInput
            v-model="password"
            type="password"
            :placeholder="t('share.enterPassword')"
            size="lg"
            autofocus
            class="mb-3"
          />

          <p v-if="error" class="text-sm text-red-500 mb-3">{{ error }}</p>

          <div class="flex gap-2">
            <UButton
              variant="ghost"
              class="flex-1"
              @click="handleClose"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              class="flex-1"
              :loading="loading"
              :disabled="!password"
            >
              {{ t('share.unlock') }}
            </UButton>
          </div>
        </form>
      </div>
    </template>
  </UModal>
</template>
