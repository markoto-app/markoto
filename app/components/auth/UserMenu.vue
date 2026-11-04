<script setup lang="ts">
const { t } = useI18n()
const { loggedIn, user } = useUserSession()
const { logout } = useLogout()
const { status: accountStatus } = useAccountStatus()

// Build the menu items reactively — the Admin item only surfaces
// when the current user is on the admin allowlist (env-driven via
// NUXT_ADMIN_USER_EMAILS, exposed through /api/user/account-status).
type MenuItem = { label: string, icon: string, to?: string, onSelect?: () => unknown }
const { pricingVisible } = useBillingMode()
const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = []
  // Pricing only when there's something to show: live plans, or the
  // hosted SaaS "coming soon" page. A self-hosted instance has neither.
  if (pricingVisible.value) {
    items.push({
      label: t('pricing.title'),
      icon: 'i-lucide-credit-card',
      to: '/pricing'
    })
  }
  items.push({
    label: t('settings.profile.title'),
    icon: 'i-lucide-user',
    to: '/settings/profile'
  })
  items.push({
    label: t('aiProvider.menu'),
    icon: 'i-lucide-key-round',
    to: AI_SETTINGS_ROUTE
  })
  // Personal access tokens for MCP clients (Claude, Cursor, scripts).
  items.push({
    label: t('settings.integrations.menu'),
    icon: 'i-lucide-plug',
    to: '/settings/integrations'
  })
  items.push({
    label: t('common.documentation'),
    icon: 'i-lucide-book-open',
    to: '/docs'
  })
  if (accountStatus.value?.isAdmin) {
    items.push({
      label: 'Admin',
      icon: 'i-lucide-shield-check',
      to: '/admin/abuse-reports'
    })
  }
  items.push({
    label: t('auth.logout'),
    icon: 'i-lucide-log-out',
    onSelect: () => logout()
  })
  return items
})
</script>

<template>
  <div
    v-if="loggedIn"
    class="flex items-center gap-2"
  >
    <!-- Plan + usage bar. Clickable → /pricing. Same component used
         across every page (driven by shared `useBilling` state), so
         the bar ticks down live as the user consumes credits. -->
    <AuthUsageBadge />

    <UDropdownMenu :items="menuItems">
      <UButton
        color="neutral"
        variant="ghost"
        class="gap-2"
        data-testid="user-menu-trigger"
      >
        <CommonUserAvatar
          v-if="user"
          :seed="avatarSeedFor({ id: user.id })"
          :size="24"
        />
        <span class="hidden sm:inline font-serif text-base font-normal tracking-tight">{{ user?.name }}</span>
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
