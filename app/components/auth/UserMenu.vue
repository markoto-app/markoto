<script setup lang="ts">
// Header account control: the login popover for anonymous visitors, the
// usage badge + account menu (AuthSignedInMenu, Lazy — its code loads only
// for signed-in users) otherwise.
const { t } = useI18n()
const { loggedIn } = useUserSession()
</script>

<template>
  <LazyAuthSignedInMenu v-if="loggedIn" />
  <div v-else>
    <UPopover>
      <UButton
        icon="i-lucide-log-in"
        color="neutral"
        variant="ghost"
      >
        {{ t('auth.login') }}
      </UButton>
      <template #content>
        <div class="p-4 w-64">
          <AuthLoginButtons />
        </div>
      </template>
    </UPopover>
  </div>
</template>
