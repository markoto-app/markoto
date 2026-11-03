<script setup lang="ts">
// Legal footer link cluster — Privacy / Terms / DPA / Sub-processors /
// Abuse policy. Mounted on /index, /pricing, /settings/profile;
// deliberately NOT in the editor or workspace surfaces (they're
// chromeless work surfaces and a footer would compete with the
// preview/editor layout).
//
// Renders for anonymous + logged-in users alike — the regulatory
// disclosure obligations don't care whether the reader has a
// session.

const { t } = useI18n()
// Legal links + the cookie note only where the legal
// surfaces exist (hosted SaaS). The copyright line names the operator
// when one is configured — never the hosted operator on a self-hosted
// instance (shared/config/instance.ts).
const { legalSurfaces, operatorName } = useInstanceConfig()

interface FooterLink {
  to: string
  label: string
  // Optional eyebrow text for screenreaders. The visible text is
  // already short enough; this exists only if a future link's
  // visible label drifts away from a clear regulatory term.
  ariaLabel?: string
}

const links: FooterLink[] = [
  { to: '/legal/privacy', label: t('legal.footer.privacy') },
  { to: '/legal/terms', label: t('legal.footer.terms') },
  { to: '/legal/dpa', label: t('legal.footer.dpa') },
  { to: '/legal/sub-processors', label: t('legal.footer.subProcessors') },
  { to: '/legal/abuse-policy', label: t('legal.footer.abuse') },
  { to: '/legal/imprint', label: t('legal.footer.imprint') }
]
</script>

<template>
  <footer
    class="legal-footer"
    role="contentinfo"
    data-testid="legal-footer"
  >
    <div class="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-3 flex flex-col sm:flex-row items-center sm:items-center justify-between gap-2 sm:gap-4">
      <div class="text-xs text-muted font-mono">
        © {{ new Date().getFullYear() }} {{ operatorName || 'markoto' }}
      </div>
      <nav
        v-if="legalSurfaces"
        class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
        :aria-label="t('legal.footer.privacy')"
      >
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          :aria-label="link.ariaLabel"
          class="text-xs font-mono text-muted hover:text-default transition-colors"
        >
          {{ link.label }}
        </NuxtLink>
        <!-- No consent banner exists (essential storage only); this note
             says so and points at the cookie list in privacy §9. -->
        <NuxtLink
          to="/legal/privacy"
          class="text-xs font-mono text-muted hover:text-default transition-colors"
          data-testid="footer-cookie-note"
        >
          {{ t('legal.footer.cookieNote') }}
        </NuxtLink>
      </nav>
    </div>
  </footer>
</template>

<style scoped>
.legal-footer {
  border-top: 1px solid color-mix(in srgb, var(--color-sumi-300, #d3cdb6) 50%, transparent);
  background: var(--ui-bg-muted);
}
:global(.dark) .legal-footer {
  border-top: 1px solid color-mix(in srgb, var(--color-sumi-700, #3a3631) 50%, transparent);
}
</style>
