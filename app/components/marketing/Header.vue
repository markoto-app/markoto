<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// Site header of the public pages: the home page (tour, plain hero and
// dashboard), /pricing and the marketing pages (layouts/marketing.vue).
//
// Links: Pricing (where a pricing page is worth showing,
// `useBillingMode().pricingVisible`), Use cases + Compare (menus from the
// marketing content collection, hidden while empty), Self-host and Docs.
// The marketing links exist only on the hosted marketing site and only
// for visitors who aren't signed in — the dashboard is a work surface.
// From `lg` the links sit inline; below, one "Menu" dropdown holds them.
//
// The colour-mode control is a slot: the product tour swaps in its own
// page-local toggle (pages/index.vue).
withDefaults(defineProps<{
  /** Show the "Start writing" button (marketing layout; the home page has its own CTAs). */
  start?: boolean
}>(), { start: false })

const { t } = useI18n()
const { loggedIn } = useUserSession()
const { marketingSite } = useInstanceConfig()
const { pricingVisible } = useBillingMode()
const nav = useMarketingNav()

const SELF_HOST_PATH = '/docs/getting-started/self-hosting'
const marketingLinks = computed(() => marketingSite.value && !loggedIn.value)

interface FlatLink { label: string, to: string, testid: string }
const leading = computed<FlatLink[]>(() => pricingVisible.value
  ? [{ label: t('marketing.nav.pricing'), to: '/pricing', testid: 'header-pricing-link' }]
  : [])
const trailing = computed<FlatLink[]>(() => marketingLinks.value
  ? [{ label: t('marketing.nav.selfHost'), to: SELF_HOST_PATH, testid: 'header-self-host-link' }]
  : [])

interface Menu { label: string, items: DropdownMenuItem[], testid: string }
const menus = computed<Menu[]>(() => {
  if (!marketingLinks.value) return []
  const out: Menu[] = []
  if (nav.value.useCases.length) {
    out.push({ label: t('marketing.nav.useCases'), testid: 'header-use-cases', items: nav.value.useCases.map(l => ({ label: l.label, to: l.to })) })
  }
  if (nav.value.compare.length) {
    out.push({ label: t('marketing.nav.compare'), testid: 'header-compare', items: nav.value.compare.map(l => ({ label: l.label, to: l.to })) })
  }
  return out
})

// Everything in one menu for narrow screens, grouped like the inline row.
const compactItems = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = []
  const top = [...leading.value, ...trailing.value].map(l => ({ label: l.label, to: l.to }))
  top.push({ label: t('common.docs'), to: '/docs' })
  groups.push(top)
  // Group headings at weight 500 like the rest of the chrome (Nuxt UI's label is 600).
  for (const menu of menus.value) groups.push([{ label: menu.label, type: 'label', class: 'font-medium text-muted' }, ...menu.items])
  return groups
})
const hasCompactMenu = computed(() => compactItems.value.flat().length > 1)
</script>

<template>
  <header class="mk-site-header border-b border-default px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
    <div class="flex items-center gap-4 min-w-0">
      <NuxtLink
        to="/"
        class="flex items-center shrink-0"
        aria-label="markoto home"
      >
        <CommonWordmark :size="20" />
      </NuxtLink>
      <nav
        v-if="leading.length || menus.length || trailing.length"
        class="hidden lg:flex items-center gap-1"
        :aria-label="t('marketing.nav.label')"
      >
        <UButton
          v-for="link in leading"
          :key="link.to"
          :to="link.to"
          color="neutral"
          variant="ghost"
          :data-testid="link.testid"
        >
          {{ link.label }}
        </UButton>
        <UDropdownMenu
          v-for="menu in menus"
          :key="menu.label"
          :items="menu.items"
        >
          <UButton
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-chevron-down"
            :data-testid="menu.testid"
          >
            {{ menu.label }}
          </UButton>
        </UDropdownMenu>
        <UButton
          v-for="link in trailing"
          :key="link.to"
          :to="link.to"
          color="neutral"
          variant="ghost"
          :data-testid="link.testid"
        >
          {{ link.label }}
        </UButton>
      </nav>
    </div>
    <div class="flex items-center gap-1 sm:gap-2 shrink-0">
      <!-- The user documentation, for everyone. Icon-only on phones. -->
      <UButton
        to="/docs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-book-open"
        :aria-label="t('common.documentation')"
        :class="hasCompactMenu ? 'hidden lg:inline-flex' : ''"
        data-testid="header-docs-link"
      >
        <span class="hidden sm:inline">{{ t('common.docs') }}</span>
      </UButton>
      <UDropdownMenu
        v-if="hasCompactMenu"
        :items="compactItems"
        :content="{ align: 'end' }"
      >
        <UButton
          class="lg:hidden"
          color="neutral"
          variant="ghost"
          icon="i-lucide-menu"
          :aria-label="t('common.menu')"
          data-testid="header-menu"
        >
          <span class="hidden sm:inline">{{ t('common.menu') }}</span>
        </UButton>
      </UDropdownMenu>
      <MarketingStartButton
        v-if="start"
        class="hidden sm:inline-flex"
        testid="header-start-writing"
      />
      <AuthUserMenu />
      <slot name="mode">
        <UColorModeButton />
      </slot>
    </div>
  </header>
</template>
