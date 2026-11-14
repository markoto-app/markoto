<script setup lang="ts">
// Confirmation before an admin removes someone from the workspace. With
// single sign-on active, a removed member whose address is in a verified
// domain can simply sign in through the IdP again and rejoin (the IdP
// decides who belongs), so the dialog says to remove them there too.
defineProps<{
  name: string
  ssoActive: boolean
  busy: boolean
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  confirm: []
}>()

const { t } = useI18n()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('workspace.members.removeConfirmTitle', { name })"
    :ui="{ content: 'sm:max-w-md' }"
  >
    <template #body>
      <div
        class="space-y-3 text-sm"
        data-testid="workspace-remove-member-dialog"
      >
        <p class="text-muted">
          {{ t('workspace.members.removeConfirmBody') }}
        </p>
        <p
          v-if="ssoActive"
          class="flex items-start gap-2 text-muted"
          data-testid="workspace-remove-member-sso-note"
        >
          <UIcon
            name="i-lucide-key-round"
            class="size-4 shrink-0 mt-0.5"
          />
          <span>{{ t('workspace.members.removeSsoNote') }}</span>
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          variant="ghost"
          :disabled="busy"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="error"
          :loading="busy"
          data-testid="workspace-remove-member-confirm"
          @click="emit('confirm')"
        >
          {{ t('workspace.members.removeConfirm') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
