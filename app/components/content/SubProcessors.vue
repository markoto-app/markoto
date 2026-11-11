<script setup lang="ts">
// The sub-processor list of this deployment, for marketing content:
//
//   ::sub-processors
//   ::
//
// Read from the same endpoint as /legal/sub-processors
// (`server/legal/subProcessors.ts` via `registryView.ts`, so Stripe is
// left out while billing is off) — never retyped in a page, so a page
// can't drift from the registry. Rendered on the server. Without legal
// surfaces the endpoint answers 404 and the block renders nothing.
const { t } = useI18n()

const { data } = await useFetch('/api/_internal/sub-processors', {
  key: 'marketing-sub-processors',
  default: () => []
})

const rows = computed(() => (data.value ?? []).map(sp => ({
  id: sp.id,
  name: sp.name,
  purpose: sp.purpose,
  location: t(`marketing.subProcessors.location.${sp.location}`),
  transfer: t(`marketing.subProcessors.transfer.${sp.transferMechanism}`),
  inEu: sp.transferMechanism === 'intra_eu'
})))
</script>

<template>
  <div
    v-if="rows.length"
    class="mk-subproc not-prose"
    data-testid="marketing-sub-processors"
  >
    <ul class="mk-subproc__list">
      <li
        v-for="row in rows"
        :key="row.id"
        class="mk-subproc__item"
      >
        <div class="mk-subproc__head">
          <span class="mk-subproc__name">{{ row.name }}</span>
          <span
            class="mk-subproc__chip"
            :class="{ 'mk-subproc__chip--eu': row.inEu }"
          >{{ row.location }} · {{ row.transfer }}</span>
        </div>
        <p class="mk-subproc__purpose">
          {{ row.purpose }}
        </p>
      </li>
    </ul>
    <p class="mk-subproc__caption">
      {{ t('marketing.subProcessors.caption') }}
      <NuxtLink to="/legal/sub-processors">
        {{ t('marketing.subProcessors.link') }}
      </NuxtLink>
    </p>
  </div>
</template>

<style scoped>
.mk-subproc { margin: 20px 0 28px; }
.mk-subproc__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--ui-border);
}
.mk-subproc__item {
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}
.mk-subproc__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}
.mk-subproc__name { font-weight: 500; font-size: 15px; }
.mk-subproc__chip {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--ui-text-muted);
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
}
.mk-subproc__chip--eu {
  color: var(--ui-text);
  border-color: var(--ui-border-accented);
}
.mk-subproc__purpose {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.mk-subproc__caption {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.mk-subproc__caption a { text-decoration: underline; text-underline-offset: 2px; color: var(--ui-text); }
</style>
