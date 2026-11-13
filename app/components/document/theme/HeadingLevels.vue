<script setup lang="ts">
import { HEADING_LEVEL_KEYS, type DocTheme, type HeadingLevelKey, type HeadingLevels, type HeadingLevelStyle, type HeadingStyle } from '~~/shared/types/theme'
import { resolveHeadingLevel } from '~~/shared/utils/theme/themeOptions'
import { HEADING_SCALE_EXPONENTS } from '~~/shared/utils/theme/themeToCss'
import { useFontWeightItems } from '~/composables/document/themeFieldOptions'

// Per-level heading look (headings.levels.h1–h4). Each control shows the
// value in effect (scale / theme-wide weight) and writes only what the
// user changes; "Use defaults" removes the level's overrides again.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const FONT_WEIGHT_ITEMS = useFontWeightItems()
const headingLevelsOpen = ref(Boolean(theme.value.headings.levels && Object.keys(theme.value.headings.levels).length))
function onHeadingLevelsToggle(e: Event) {
  if (e.target instanceof HTMLDetailsElement) headingLevelsOpen.value = e.target.open
}
function levelEntry(key: HeadingLevelKey): HeadingLevelStyle | undefined {
  return theme.value.headings.levels?.[key]
}
/** `headings.levels` with level `key` replaced by `entry` (empty levels left out). */
function levelsWith(key: HeadingLevelKey, entry: HeadingLevelStyle | undefined): HeadingLevels {
  const next: HeadingLevels = {}
  for (const k of HEADING_LEVEL_KEYS) {
    const e = k === key ? entry : levelEntry(k)
    if (e && Object.keys(e).length) next[k] = e
  }
  return next
}
function setLevelField<K extends keyof HeadingLevelStyle>(key: HeadingLevelKey, field: K, value: HeadingLevelStyle[K] | undefined) {
  const merged: HeadingLevelStyle = { ...levelEntry(key), [field]: value }
  const entry: HeadingLevelStyle = {}
  if (merged.size !== undefined) entry.size = merged.size
  if (merged.weight !== undefined) entry.weight = merged.weight
  if (merged.style !== undefined) entry.style = merged.style
  if (merged.smallCaps !== undefined) entry.smallCaps = merged.smallCaps
  if (merged.align !== undefined) entry.align = merged.align
  theme.value.headings.levels = levelsWith(key, entry)
}
function levelNumber(key: HeadingLevelKey): number {
  return HEADING_LEVEL_KEYS.indexOf(key) + 1
}
/** Size × body in effect: the override, else the scale's value for this level. */
function levelSize(key: HeadingLevelKey): number {
  const override = levelEntry(key)?.size
  if (override !== undefined) return override
  const exp = HEADING_SCALE_EXPONENTS[levelNumber(key) - 1] ?? 0
  return Math.round(Math.pow(theme.value.headings.scale, exp) * 100) / 100
}
function setLevelSize(key: HeadingLevelKey, v: number | null | undefined) {
  setLevelField(key, 'size', typeof v === 'number' ? v : undefined)
}
function levelWeight(key: HeadingLevelKey): number {
  return resolveHeadingLevel(theme.value, levelNumber(key)).weight
}
function setLevelWeight(key: HeadingLevelKey, v: number) {
  setLevelField(key, 'weight', v)
}
function levelItalic(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(theme.value, levelNumber(key)).style === 'italic'
}
function setLevelItalic(key: HeadingLevelKey, v: boolean) {
  const style: HeadingStyle = v ? 'italic' : 'normal'
  setLevelField(key, 'style', style)
}
function levelCentered(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(theme.value, levelNumber(key)).align === 'center'
}
function setLevelCentered(key: HeadingLevelKey, v: boolean) {
  setLevelField(key, 'align', v ? 'center' : undefined)
}
function levelSmallCaps(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(theme.value, levelNumber(key)).smallCaps
}
function setLevelSmallCaps(key: HeadingLevelKey, v: boolean) {
  setLevelField(key, 'smallCaps', v)
}
function levelHasOverrides(key: HeadingLevelKey): boolean {
  return Object.keys(levelEntry(key) ?? {}).length > 0
}
function resetLevel(key: HeadingLevelKey) {
  theme.value.headings.levels = levelsWith(key, undefined)
}
</script>

<template>
  <details
    class="rounded-md border border-default"
    data-testid="theme-heading-levels"
    :open="headingLevelsOpen"
    @toggle="onHeadingLevelsToggle"
  >
    <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
      {{ t('theme.headings.levels') }}
    </summary>
    <div class="space-y-4 px-3 pb-3">
      <p class="text-xs text-muted">
        {{ t('theme.headings.levelsHelp') }}
      </p>
      <div
        v-for="key in HEADING_LEVEL_KEYS"
        :key="key"
        class="space-y-2"
        :data-testid="`theme-heading-level-${key}`"
      >
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">{{ t('theme.headings.levelTitle', { level: levelNumber(key) }) }}</span>
          <UButton
            v-if="levelHasOverrides(key)"
            size="xs"
            color="neutral"
            variant="ghost"
            :data-testid="`theme-heading-level-${key}-reset`"
            @click="resetLevel(key)"
          >
            {{ t('theme.headings.levelReset') }}
          </UButton>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <UFormField :label="t('theme.headings.levelSize')">
            <UInputNumber
              :model-value="levelSize(key)"
              :min="0.5"
              :max="4"
              :step="0.05"
              class="w-full"
              :data-testid="`theme-heading-level-${key}-size`"
              @update:model-value="(v: number | null | undefined) => setLevelSize(key, v)"
            />
          </UFormField>
          <UFormField :label="t('theme.headings.weight')">
            <USelect
              :model-value="levelWeight(key)"
              :items="FONT_WEIGHT_ITEMS"
              class="w-full"
              @update:model-value="(v: number) => setLevelWeight(key, v)"
            />
          </UFormField>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <USwitch
            :model-value="levelItalic(key)"
            :label="t('theme.headings.levelItalic')"
            @update:model-value="(v: boolean) => setLevelItalic(key, v)"
          />
          <USwitch
            :model-value="levelSmallCaps(key)"
            :label="t('theme.headings.levelSmallCaps')"
            @update:model-value="(v: boolean) => setLevelSmallCaps(key, v)"
          />
          <USwitch
            :model-value="levelCentered(key)"
            :label="t('theme.headings.levelCentered')"
            :data-testid="`theme-heading-level-${key}-centered`"
            @update:model-value="(v: boolean) => setLevelCentered(key, v)"
          />
        </div>
      </div>
    </div>
  </details>
</template>
