<script setup lang="ts">
// The sign-in choice in a dialog, for a call to action that needs an
// account first (the pricing page's "Sign up"): the same providers as the
// header's sign-in (GitHub, Google, the instance's OIDC provider, the
// organisation's single sign-on), each returning to `returnTo`.
defineProps<{
  open: boolean
  title: string
  description?: string
  /** Page to come back to after signing in. */
  returnTo: string
}>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :description="description"
    :ui="{ content: 'max-w-sm' }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div data-testid="sign-in-modal">
        <AuthLoginButtons :return-to="returnTo" />
      </div>
    </template>
  </UModal>
</template>
