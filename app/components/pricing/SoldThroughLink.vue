<script setup lang="ts">
// "Sold through Link (Stripe)": with Stripe Managed Payments, Link is the
// seller of every paid plan and AI credit pack, so the pricing page and
// every purchase box name it and link its buyer terms. Renders nothing
// without Managed Payments.
const { t } = useI18n()
const { managedPayments } = useBillingMode()
</script>

<template>
  <p v-if="managedPayments">
    <i18n-t
      keypath="billing.soldThroughLink.note"
      scope="global"
    >
      <template #terms>
        <a
          href="https://link.com/terms"
          target="_blank"
          rel="noopener"
          class="underline"
        >{{ t('billing.soldThroughLink.terms') }}</a>
      </template>
    </i18n-t>
  </p>
</template>
