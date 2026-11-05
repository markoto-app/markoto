<script setup lang="ts">
import { selfHostPath } from '~~/shared/seo/marketing'

// Site footer: the user documentation and, on the hosted SaaS, the legal
// documents. Mounted on /, /pricing, /settings/profile, the /legal/* and
// /admin pages and the /docs layout; deliberately NOT in the editor or
// workspace surfaces (they're chromeless work surfaces and a footer would
// compete with the preview/editor layout).
//
// Up to three groups, each with dot separators so the links don't run together:
//   0. the site: Pricing (where shown) and, on the hosted marketing site,
//      Self-host + the use-case / comparison / template pages (useMarketingNav)
//   1. what a visitor looks for: Docs · Privacy · Terms · Imprint · Report abuse
//   2. the reference documents, quieter: DPA · Sub-processors · Cookies note
// Every legal page stays one click away. Renders for anonymous +
// logged-in users alike — the disclosure obligations don't care whether
// the reader has a session.

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
}

const siteLinks = computed<FooterLink[]>(() => [
  ...(pricingVisible.value ? [{ to: '/pricing', label: t('marketing.nav.pricing'), testid: 'footer-pricing-link' }] : []),
  ...(marketingSite.value
    ? [
        { to: selfHostPath(marketingSite.value), label: t('marketing.nav.selfHost'), testid: 'footer-self-host-link' },
        ...nav.value.useCases,
        ...nav.value.compare,
        ...nav.value.templates
      ]
    : [])
])

const primaryLinks = computed<FooterLink[]>(() => [
  { to: '/docs', label: t('common.docs'), testid: 'footer-docs-link' },
  ...(legalSurfaces.value
    ? [
        { to: '/legal/privacy', label: t('legal.footer.privacy') },
        { to: '/legal/terms', label: t('legal.footer.terms') },
        { to: '/legal/imprint', label: t('legal.footer.imprint') },
        { to: '/legal/abuse-policy', label: t('legal.footer.abuse') }
      ]
    : [])
])

const referenceLinks = computed<FooterLink[]>(() => legalSurfaces.value
  ? [
      { to: '/legal/dpa', label: t('legal.footer.dpaShort'), fullName: t('legal.footer.dpa') },
      { to: '/legal/sub-processors', label: t('legal.footer.subProcessors') },
      // No consent banner exists (essential storage only); this note says
      // so and points at the cookie list in privacy §9.
      { to: '/legal/privacy', label: t('legal.footer.cookieNote'), testid: 'footer-cookie-note' }
    ]
  : [])
</script>

<template>
  <footer
    class="legal-footer"
    role="contentinfo"
    data-testid="legal-footer"
  >
    <div class="legal-footer__inner">
      <p class="legal-footer__copy">
        © {{ new Date().getFullYear() }} {{ operatorName || 'markoto' }}
      </p>
      <nav
        class="legal-footer__nav"
        :aria-label="t('legal.footer.navLabel')"
      >
        <ul
          v-if="siteLinks.length > 0"
          class="legal-footer__list"
          data-testid="footer-site-links"
        >
          <li
            v-for="link in siteLinks"
            :key="link.to"
          >
            <NuxtLink
              :to="link.to"
              class="legal-footer__link"
              :data-testid="link.testid"
            >
              {{ link.label }}
            </NuxtLink>
          </li>
        </ul>
        <ul class="legal-footer__list">
          <li
            v-for="link in primaryLinks"
            :key="link.to"
          >
            <NuxtLink
              :to="link.to"
              class="legal-footer__link"
              :data-testid="link.testid"
            >
              {{ link.label }}
            </NuxtLink>
          </li>
        </ul>
        <ul
          v-if="referenceLinks.length > 0"
          class="legal-footer__list legal-footer__list--quiet"
        >
          <li
            v-for="link in referenceLinks"
            :key="link.label"
          >
            <NuxtLink
              :to="link.to"
              class="legal-footer__link"
              :aria-label="link.fullName"
              :title="link.fullName"
              :data-testid="link.testid"
            >
              {{ link.label }}
            </NuxtLink>
          </li>
        </ul>
      </nav>
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
  max-width: 64rem;
  margin-inline: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}
.legal-footer__copy {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.legal-footer__nav {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.legal-footer__list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  row-gap: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.legal-footer__list--quiet { font-size: 11px; }
/* A middle dot between items. It trails its item, so a wrapped line
   ends on a dot instead of starting with one. Empty alt text: screen
   readers skip it. */
.legal-footer__list > li:not(:last-child)::after {
  content: '·';
  content: '·' / '';
  padding-inline: 8px;
  color: var(--ui-text-dimmed);
}
.legal-footer__link {
  color: var(--ui-text-muted);
  transition: color 150ms ease;
}
.legal-footer__link:hover { color: var(--ui-text); }
.legal-footer__list--quiet .legal-footer__link { color: var(--ui-text-dimmed); }
.legal-footer__list--quiet .legal-footer__link:hover { color: var(--ui-text); }
@media (min-width: 640px) {
  .legal-footer__inner {
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
    padding: 18px 24px;
    text-align: left;
  }
  .legal-footer__nav { align-items: flex-end; }
  .legal-footer__list { justify-content: flex-end; }
}
</style>
