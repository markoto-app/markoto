<script setup lang="ts">
import { selfHostPath } from '~~/shared/seo/marketing'
import { SOURCE_REPO_URL } from '~~/shared/config/links'

// Site header of the public pages: the home page (tour, plain hero and
// dashboard), /pricing and the marketing pages (layouts/marketing.vue).
//
// Deliberately short: Pricing (where a pricing page is worth showing,
// `useBillingMode().pricingVisible`), Self-host (hosted marketing site,
// signed-out visitors only) and Docs. The use-case, comparison and
// template pages exist to bring visitors in from search, not to send them
// away from the home page, so they are linked from the site footer
// (CommonLegalFooter) only. No menus: the links fit on a phone, Self-host
// moves to the footer below `sm`.
//
// Plus an icon link to the source repository on GitHub, for everyone
// (from 400px; narrower phones find it in the footer's Product column).
//
// The colour-mode control is a slot: the product tour swaps in its own
// page-local toggle (pages/index.vue).
//
// A plain <header> of Tailwind utilities + UButton, not UHeader: UHeader
// is built around its mobile menu (we want none) and, even with
// `toggle: false`, fetches the menu's modal chunk on idle after mount, on
// every public page. Its slots would also have to undo its sticky,
// blurred, fixed-height, max-width frame.
withDefaults(defineProps<{
  /** Show the "Start writing" button (marketing layout; the home page has its own CTAs). */
  start?: boolean
}>(), { start: false })

const { t } = useI18n()
const { loggedIn } = useUserSession()
const { marketingSite } = useInstanceConfig()
const { pricingVisible } = useBillingMode()

interface HeaderLink { label: string, to: string, testid: string, class?: string }
const links = computed<HeaderLink[]>(() => [
  ...(pricingVisible.value ? [{ label: t('marketing.nav.pricing'), to: '/pricing', testid: 'header-pricing-link' }] : []),
  ...(marketingSite.value && !loggedIn.value
    ? [{ label: t('marketing.nav.selfHost'), to: selfHostPath(marketingSite.value), testid: 'header-self-host-link', class: 'hidden sm:inline-flex' }]
    : [])
])
</script>

<template>
  <header class="mk-site-header border-b border-default px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 sm:gap-4 min-w-0">
      <NuxtLink
        to="/"
        class="flex items-center shrink-0"
        aria-label="markoto home"
      >
        <CommonWordmark :size="20" />
        <CommonInstanceBrand
          class="ml-2.5"
          :size="20"
        />
      </NuxtLink>
      <nav
        class="flex items-center gap-0.5 sm:gap-1 shrink-0"
        :aria-label="t('marketing.nav.label')"
      >
        <UButton
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          color="neutral"
          variant="ghost"
          :class="link.class"
          :data-testid="link.testid"
        >
          {{ link.label }}
        </UButton>
        <!-- The user documentation, for everyone. -->
        <UButton
          to="/docs"
          color="neutral"
          variant="ghost"
          data-testid="header-docs-link"
        >
          {{ t('common.docs') }}
        </UButton>
      </nav>
    </div>
    <div class="flex items-center gap-1 sm:gap-2 shrink-0">
      <!-- The source repository (source-available, FSL-1.1). -->
      <UButton
        :to="SOURCE_REPO_URL"
        target="_blank"
        rel="noopener"
        color="neutral"
        variant="ghost"
        icon="i-simple-icons-github"
        class="hidden min-[400px]:inline-flex"
        :aria-label="t('marketing.nav.github')"
        :title="t('marketing.nav.github')"
        data-testid="header-github-link"
      />
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
