<script setup lang="ts">
const { t } = useI18n()
const { loggedIn, user, clear } = useUserSession()
</script>

<template>
  <div v-if="loggedIn" class="flex items-center gap-2">
    <UDropdownMenu
      :items="[
        {
          label: t('auth.logout'),
          icon: 'i-lucide-log-out',
          onSelect: () => clear()
        }
      ]"
    >
      <UButton color="neutral" variant="ghost" class="gap-2">
        <UAvatar
          :src="user?.avatar ?? undefined"
          :alt="user?.name"
          size="xs"
        />
        <span class="hidden sm:inline text-sm">{{ user?.name }}</span>
      </UButton>
    </UDropdownMenu>
  </div>
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
