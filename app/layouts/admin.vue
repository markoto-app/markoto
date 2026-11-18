<script setup lang="ts">
import { ADMIN_SECTIONS, adminSectionOf } from '~/utils/admin/adminSections'

// Chrome of every admin page: wordmark, the admin sub-navigation, the
// account menu and the footer. All of it is left out of print, so a page
// (the investor summary) prints as itself.
//
// Print always uses the light theme: paper is white, and browsers drop
// background colours, so dark-mode text would print light grey on white.
// This listener is registered before the page's charts mount theirs, so
// the charts redraw with the light tokens already in place.

const { t } = useI18n()
const route = useRoute()
const active = computed(() => adminSectionOf(route.path))

let restoreDark = false
useEventListener('beforeprint', () => {
  const root = document.documentElement
  restoreDark = root.classList.contains('dark')
  if (restoreDark) root.classList.remove('dark')
})
useEventListener('afterprint', () => {
  if (restoreDark) document.documentElement.classList.add('dark')
  restoreDark = false
})
</script>

<template>
  <div class="min-h-[100dvh] flex flex-col bg-muted text-default print:bg-transparent">
    <header class="bg-muted border-b border-default print:hidden">
      <div class="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <NuxtLink
            to="/"
            class="inline-flex items-center gap-2.5 hover:opacity-80 transition-opacity"
            :aria-label="t('common.homeLinkLabel')"
            data-testid="page-home-link"
          >
            <CommonWordmark :size="18" />
            <CommonInstanceBrand :size="18" />
          </NuxtLink>
          <span class="font-mono text-[11px] uppercase tracking-wider text-muted">
            {{ t('admin.title') }}
          </span>
        </div>
        <AuthUserMenu />
      </div>
      <nav
        class="mx-auto max-w-6xl px-2 sm:px-3 overflow-x-auto"
        :aria-label="t('admin.navLabel')"
        data-testid="admin-nav"
      >
        <ul class="flex items-center gap-1 min-w-max">
          <li
            v-for="s in ADMIN_SECTIONS"
            :key="s.key"
          >
            <NuxtLink
              :to="s.to"
              class="inline-flex items-center gap-1.5 px-2 sm:px-3 py-2.5 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors"
              :class="active === s.key ? 'border-inverted text-default' : 'border-transparent text-muted hover:text-default'"
              :aria-current="active === s.key ? 'page' : undefined"
              :data-testid="`admin-nav-${s.key}`"
            >
              <UIcon
                :name="s.icon"
                class="size-4 shrink-0"
              />
              {{ t(`admin.nav.${s.key}`) }}
            </NuxtLink>
          </li>
        </ul>
      </nav>
    </header>

    <main class="flex-1 w-full mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-10 print:max-w-none print:p-0">
      <slot />
    </main>

    <CommonLegalFooter class="print:hidden" />
  </div>
</template>
