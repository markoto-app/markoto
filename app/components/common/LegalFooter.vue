<script setup lang="ts">
import { selfHostPath } from '~~/shared/seo/marketing'
import { SOURCE_REPO_URL } from '~~/shared/config/links'

// Site footer: the site map of the public pages. Mounted on /, /pricing,
// /settings/profile, the /legal/* and /admin pages, the /docs layout and
// layouts/marketing.vue; deliberately NOT in the editor or workspace
// surfaces (they're chromeless work surfaces and a footer would compete
// with the preview/editor layout).
//
// Columns of plain links, each shown only when it has links:
//   Product    Pricing (where shown), Self-host (marketing site), Docs, GitHub
//   Use cases  ┐
//   Compare    ├ the marketing content pages (useMarketingNav; marketing site only)
//   Templates  ┘
//   Legal      Privacy · Terms · Imprint · Report abuse · DPA ·
//              Sub-processors · Cookies note (hosted SaaS only)
// The use-case, comparison and template pages are linked here and NOT in
// the header (MarketingHeader): they bring visitors in from search; the
// home page shouldn't send its visitors away to them. Every legal page
// stays one click away, for anonymous and signed-in readers alike.

const { t } = useI18n()
// Legal links + the cookie note only where the legal surfaces exist
// (hosted SaaS). The copyright line names the operator when one is
// configured — never the hosted operator on a self-hosted instance
// (shared/config/instance.ts).
const { legalSurfaces, operatorName, marketingSite } = useInstanceConfig()
const { supportHref } = useInstanceSupport()
const { pricingVisible, billingEnabled } = useBillingMode()
const nav = useMarketingNav()

// Layout on top of Nuxt UI's footer: the same 72rem column as the
// marketing pages, brand left of the link columns from `lg`, two link
// columns on phones and as many as fit from `sm`, the copyright row
// under a hairline. (Variant prefixes repeat where the default theme
// sets an `lg:` / `xl:` value of its own.)
const ui = {
  top: 'pt-10 pb-6 sm:pt-12 sm:pb-7 lg:pt-12 lg:pb-7',
  container: 'max-w-6xl lg:px-6 flex lg:flex pt-3.5 pb-[18px] lg:pt-3.5 lg:pb-[18px] border-t border-sumi-300/35 dark:border-sumi-700/40',
  left: 'justify-start lg:justify-start mt-0',
  center: 'hidden',
  right: 'hidden'
}
const columnsUi = {
  root: 'grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[14rem_minmax(0,1fr)] xl:gap-12',
  left: 'mb-0 xl:mb-0 flex flex-col gap-2.5',
  center: 'grid lg:grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid-flow-row gap-x-5 gap-y-7 xl:col-span-1'
}

interface FooterLink {
  to: string
  label: string
  /** Full name for screen readers + tooltip when the label is an abbreviation. */
  fullName?: string
  testid?: string
  /** Off-site link: opens in a new tab. */
  external?: boolean
}

interface FooterColumn {
  id: string
  heading: string
  links: FooterLink[]
}

const columns = computed<FooterColumn[]>(() => {
  const product: FooterLink[] = [
    ...(pricingVisible.value ? [{ to: '/pricing', label: t('marketing.nav.pricing'), testid: 'footer-pricing-link' }] : []),
    ...(marketingSite.value ? [{ to: selfHostPath(marketingSite.value), label: t('marketing.nav.selfHost'), testid: 'footer-self-host-link' }] : []),
    { to: '/docs', label: t('common.docs'), testid: 'footer-docs-link' },
    { to: SOURCE_REPO_URL, label: 'GitHub', testid: 'footer-github-link', external: true },
    // Managed instance: the customer's own service desk.
    ...(supportHref.value ? [{ to: supportHref.value, label: t('instanceBrand.support'), testid: 'footer-support-link', external: true }] : [])
  ]
  const legal: FooterLink[] = legalSurfaces.value
    ? [
        { to: '/legal/privacy', label: t('legal.footer.privacy') },
        { to: '/legal/terms', label: t('legal.footer.terms') },
        // Only where something can be bought (billing on).
        ...(billingEnabled.value ? [{ to: '/legal/paid-terms', label: t('legal.footer.paidTerms'), testid: 'footer-paid-terms-link' }] : []),
        { to: '/legal/imprint', label: t('legal.footer.imprint') },
        { to: '/legal/abuse-policy', label: t('legal.footer.abuse') },
        { to: '/legal/dpa', label: t('legal.footer.dpaShort'), fullName: t('legal.footer.dpa') },
        { to: '/legal/sub-processors', label: t('legal.footer.subProcessors') },
        // No consent banner exists (essential storage only); this note says
        // so and points at the cookie list in privacy §9.
        { to: '/legal/privacy', label: t('legal.footer.cookieNote'), testid: 'footer-cookie-note' }
      ]
    : []
  return [
    { id: 'product', heading: t('legal.footer.product'), links: product },
    { id: 'use-cases', heading: t('marketing.nav.useCases'), links: nav.value.useCases },
    { id: 'compare', heading: t('marketing.nav.compare'), links: nav.value.compare },
    { id: 'templates', heading: t('marketing.nav.templates'), links: nav.value.templates },
    { id: 'legal', heading: t('legal.footer.legal'), links: legal }
  ].filter(column => column.links.length > 0)
})
</script>

<template>
  <!-- Root keeps `legal-footer`: the product tour snaps to it (ProductTour.vue). -->
  <UFooter
    class="legal-footer border-t border-sumi-300/50 dark:border-sumi-700/50 bg-muted"
    role="contentinfo"
    data-testid="legal-footer"
    :ui="ui"
  >
    <template #top>
      <UContainer class="max-w-6xl lg:px-6">
        <!-- Default slot rather than the `columns` prop: the prop renders
             anonymous wrappers, and each column keeps its own test id. -->
        <UFooterColumns
          :aria-label="t('legal.footer.navLabel')"
          :ui="columnsUi"
        >
          <template #left>
            <NuxtLink
              to="/"
              aria-label="markoto home"
              class="inline-flex w-fit items-center gap-2.5"
            >
              <CommonWordmark :size="18" />
              <CommonInstanceBrand
                :size="18"
                :show-name="false"
              />
            </NuxtLink>
            <p class="max-w-[22ch] text-[13px] leading-normal text-muted">
              {{ t('legal.footer.tagline') }}
            </p>
          </template>
          <section
            v-for="column in columns"
            :key="column.id"
            :data-testid="`footer-col-${column.id}`"
          >
            <h2 class="mb-2.5 font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-dimmed">
              {{ column.heading }}
            </h2>
            <ul class="flex flex-col gap-[7px] text-[13px] leading-[1.35]">
              <li
                v-for="link in column.links"
                :key="link.to + link.label"
              >
                <NuxtLink
                  :to="link.to"
                  class="text-muted transition-colors hover:text-default"
                  :aria-label="link.fullName"
                  :title="link.fullName"
                  :data-testid="link.testid"
                  :target="link.external ? '_blank' : undefined"
                  :rel="link.external ? 'noopener' : undefined"
                >
                  {{ link.label }}
                </NuxtLink>
              </li>
            </ul>
          </section>
        </UFooterColumns>
      </UContainer>
    </template>
    <template #left>
      <p class="font-mono text-[11px] text-muted">
        © {{ new Date().getFullYear() }} {{ operatorName || 'markoto' }}
      </p>
    </template>
  </UFooter>
</template>
