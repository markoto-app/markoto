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
const { pricingVisible } = useBillingMode()
const nav = useMarketingNav()

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
    { to: SOURCE_REPO_URL, label: 'GitHub', testid: 'footer-github-link', external: true }
  ]
  const legal: FooterLink[] = legalSurfaces.value
    ? [
        { to: '/legal/privacy', label: t('legal.footer.privacy') },
        { to: '/legal/terms', label: t('legal.footer.terms') },
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
  <footer
    class="legal-footer"
    role="contentinfo"
    data-testid="legal-footer"
  >
    <div class="legal-footer__inner">
      <div class="legal-footer__brand">
        <NuxtLink
          to="/"
          aria-label="markoto home"
          class="legal-footer__mark"
        >
          <CommonWordmark :size="18" />
        </NuxtLink>
        <p class="legal-footer__tagline">
          {{ t('legal.footer.tagline') }}
        </p>
      </div>
      <nav
        class="legal-footer__nav"
        :aria-label="t('legal.footer.navLabel')"
      >
        <section
          v-for="column in columns"
          :key="column.id"
          class="legal-footer__col"
          :data-testid="`footer-col-${column.id}`"
        >
          <h2 class="legal-footer__heading">
            {{ column.heading }}
          </h2>
          <ul class="legal-footer__list">
            <li
              v-for="link in column.links"
              :key="link.to + link.label"
            >
              <NuxtLink
                :to="link.to"
                class="legal-footer__link"
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
      </nav>
    </div>
    <div class="legal-footer__base">
      <p class="legal-footer__copy">
        © {{ new Date().getFullYear() }} {{ operatorName || 'markoto' }}
      </p>
    </div>
  </footer>
</template>

<style scoped>
.legal-footer {
  border-top: 1px solid color-mix(in srgb, var(--color-sumi-300, #d3cdb6) 50%, transparent);
  background: var(--ui-bg-muted);
}
html.dark .legal-footer {
  border-top-color: color-mix(in srgb, var(--color-sumi-700, #3a3631) 50%, transparent);
}
.legal-footer__inner {
  max-width: 72rem;
  margin-inline: auto;
  padding: 40px 16px 24px;
  display: grid;
  gap: 32px;
}
.legal-footer__brand {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.legal-footer__mark { display: inline-flex; width: fit-content; }
.legal-footer__tagline {
  max-width: 22ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
/* Two columns on phones, as many as fit from there on. */
.legal-footer__nav {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px 20px;
}
.legal-footer__heading {
  margin: 0 0 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-dimmed);
}
.legal-footer__list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  line-height: 1.35;
}
.legal-footer__link {
  color: var(--ui-text-muted);
  transition: color 150ms ease;
}
.legal-footer__link:hover { color: var(--ui-text); }
.legal-footer__base {
  max-width: 72rem;
  margin-inline: auto;
  padding: 14px 16px 18px;
  border-top: 1px solid color-mix(in srgb, var(--color-sumi-300, #d3cdb6) 35%, transparent);
}
html.dark .legal-footer__base {
  border-top-color: color-mix(in srgb, var(--color-sumi-700, #3a3631) 40%, transparent);
}
.legal-footer__copy {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ui-text-muted);
}
@media (min-width: 640px) {
  .legal-footer__inner { padding: 48px 24px 28px; }
  .legal-footer__nav { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .legal-footer__base { padding-inline: 24px; }
}
@media (min-width: 1024px) {
  .legal-footer__inner { grid-template-columns: 14rem minmax(0, 1fr); gap: 48px; }
}
</style>
