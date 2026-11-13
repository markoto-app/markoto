<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { mirrorMargins, resolvePageMargins } from '~~/shared/utils/theme/themeOptions'

// Theme panel → Page: size, orientation, margins (uniform, or per side).
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const pageSizeItems = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'A5 (148 × 210 mm)', value: 'A5' },
  { label: 'Letter (8.5 × 11 in)', value: 'Letter' },
  { label: 'Legal (8.5 × 14 in)', value: 'Legal' }
]
const orientationItems = computed(() => [
  { label: t('theme.portrait'), value: 'portrait' },
  { label: t('theme.landscape'), value: 'landscape' }
])
const mirrorMarginsModel = computed({
  get: () => mirrorMargins(theme.value),
  set: (v: boolean) => { theme.value.page.mirrorMargins = v }
})

// Per-side page margins: each side shows `page.margin` until set; the
// reset button removes all four (back to the uniform margin).
type MarginSide = 'top' | 'right' | 'bottom' | 'left'
const MARGIN_SIDES: readonly MarginSide[] = ['top', 'right', 'bottom', 'left']
const MARGIN_FIELDS = { top: 'marginTop', right: 'marginRight', bottom: 'marginBottom', left: 'marginLeft' } as const
const pageMarginsOpen = ref(MARGIN_SIDES.some(side => theme.value.page[MARGIN_FIELDS[side]] !== undefined))
function onPageMarginsToggle(e: Event) {
  if (e.target instanceof HTMLDetailsElement) pageMarginsOpen.value = e.target.open
}
function pageMargin(side: MarginSide): number {
  return resolvePageMargins(theme.value)[side]
}
function setPageMargin(side: MarginSide, v: number | null | undefined) {
  if (typeof v === 'number') theme.value.page[MARGIN_FIELDS[side]] = v
  else clearSideMargin(side)
}
function clearSideMargin(side: MarginSide) {
  const page = theme.value.page
  if (side === 'top') delete page.marginTop
  else if (side === 'right') delete page.marginRight
  else if (side === 'bottom') delete page.marginBottom
  else delete page.marginLeft
}
const hasSideMargins = computed(() => MARGIN_SIDES.some(side => theme.value.page[MARGIN_FIELDS[side]] !== undefined))
function resetSideMargins() {
  for (const side of MARGIN_SIDES) clearSideMargin(side)
}
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.page.size')">
      <USelect
        v-model="theme.page.size"
        :items="pageSizeItems"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.page.orientation')">
      <USelect
        v-model="theme.page.orientation"
        :items="orientationItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.page.margin')"
      :help="t('theme.page.marginHelp')"
    >
      <UInputNumber
        v-model="theme.page.margin"
        :min="0"
        :max="60"
        :step="1"
        class="w-full"
      />
    </UFormField>
    <!-- Per-side margins (page.marginTop/Right/Bottom/Left):
         collapsed unless the theme already sets one. -->
    <details
      class="rounded-md border border-default"
      data-testid="theme-page-margins"
      :open="pageMarginsOpen"
      @toggle="onPageMarginsToggle"
    >
      <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        {{ t('theme.page.sideMargins') }}
      </summary>
      <div class="space-y-3 px-3 pb-3">
        <p class="text-xs text-muted">
          {{ t('theme.page.sideMarginsHelp') }}
        </p>
        <div class="grid grid-cols-2 gap-2">
          <UFormField
            v-for="side in MARGIN_SIDES"
            :key="side"
            :label="t(`theme.page.margin_${side}`)"
          >
            <UInputNumber
              :model-value="pageMargin(side)"
              :min="0"
              :max="60"
              :step="1"
              class="w-full"
              :data-testid="`theme-page-margin-${side}`"
              @update:model-value="(v: number | null | undefined) => setPageMargin(side, v)"
            />
          </UFormField>
        </div>
        <UButton
          v-if="hasSideMargins"
          size="xs"
          color="neutral"
          variant="ghost"
          data-testid="theme-page-margins-reset"
          @click="resetSideMargins"
        >
          {{ t('theme.page.sideMarginsReset') }}
        </UButton>
        <UFormField
          :label="t('theme.page.mirrorMargins')"
          :help="t('theme.page.mirrorMarginsHelp')"
        >
          <USwitch
            v-model="mirrorMarginsModel"
            data-testid="theme-page-mirror-margins"
          />
        </UFormField>
      </div>
    </details>
  </div>
</template>
