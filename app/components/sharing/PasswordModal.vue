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
const { extractError } = useErrorHandler()
const password = ref('')
const error = ref('')

const { isLoading: loading, execute: runVerify } = useAsyncState(
  () => apiFetch('/api/docs/:docId/password', {
    method: 'post',
    path: { docId: props.docId },
    body: { action: 'verify', password: password.value }
  }),
  null,
  {
    immediate: false,
    onSuccess: (result) => {
      // The route's response type is `{ success }` for every action, so the token is checked at runtime.
      if (result && 'token' in result && typeof result.token === 'string') emit('verified', result.token)
    },
    onError: (e) => {
      error.value = extractError(e).message
      password.value = ''
    }
  }
)

async function verify() {
  if (!password.value) return
  error.value = ''
  await runVerify()
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
            <UIcon
              name="i-lucide-lock"
              class="size-6 text-amber-500"
            />
          </div>
          <h2 class="text-lg font-semibold">
            {{ t('share.passwordRequired') }}
          </h2>
          <p class="text-sm text-muted mt-1">
            {{ t('share.passwordRequiredDesc') }}
          </p>
        </div>

        <form @submit.prevent="verify">
          <UInput
            v-model="password"
            type="password"
            :placeholder="t('share.enterPassword')"
            size="lg"
            autofocus
            class="mb-3"
            data-testid="password-modal-input"
          />

          <p
            v-if="error"
            class="text-sm text-red-500 mb-3"
          >
            {{ error }}
          </p>

          <div class="flex gap-2">
            <UButton
              variant="ghost"
              class="flex-1"
              data-testid="password-modal-cancel"
              @click="handleClose"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              class="flex-1"
              :loading="loading"
              :disabled="!password"
              data-testid="password-modal-unlock"
            >
              {{ t('share.unlock') }}
            </UButton>
          </div>
        </form>
      </div>
    </template>
  </UModal>
</template>
