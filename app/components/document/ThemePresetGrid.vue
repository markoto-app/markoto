<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { THEME_PRESETS, THEME_PRESET_CATEGORIES, type ThemePreset, type ThemePresetCategory } from '~~/shared/utils/themePresets'
import { themeThumbnailUrl } from '~~/shared/utils/themeThumbnails'

/**
 * The built-in design picker: audience tabs over cards that show a
 * picture of each preset's first page (`public/theme-thumbs/<id>.webp`,
 * rendered by `make theme-thumbs`; a brand stripe + "Aa" in the heading
 * font until one exists). Shared by the new-document dialog and the
 * editor's theme panel so both always look the same.
 *
 * The parent decides what a click means (select vs. apply) and may put
 * its own cards in front of the presets through the `before` slot (saved
 * themes, the workspace default); with `savedTab` a "My designs" tab
 * shows only that slot.
 */
type Tab = 'all' | ThemePresetCategory | 'saved'

const props = withDefaults(defineProps<{
  /** Preset shown as chosen (border + aria-pressed). */
  selectedId?: string | null
  /** data-testid of each card: `${testidPrefix}${preset.id}`. */
  testidPrefix: string
  /** Show a "My designs" tab (the parent's `before` slot only). */
  savedTab?: boolean
  /** Two columns for the narrow theme panel, three in the dialog. */
  columns?: 2 | 3
}>(), { selectedId: null, savedTab: false, columns: 3 })

const emit = defineEmits<{ select: [preset: ThemePreset] }>()

const { t } = useI18n()

const tab = defineModel<Tab>('tab', { default: 'all' })

const tabs = computed<TabsItem[]>(() => [
  { label: t('newDoc.designTabs.all'), value: 'all' },
  ...THEME_PRESET_CATEGORIES
    .filter(c => THEME_PRESETS.some(p => p.category === c))
    .map(c => ({ label: t(`newDoc.designTabs.${c}`), value: c })),
  ...(props.savedTab ? [{ label: t('newDoc.designTabs.saved'), value: 'saved' }] : [])
])

// A "My designs" tab that disappears (last saved theme deleted) falls back to All.
watch(() => props.savedTab, (has) => {
  if (!has && tab.value === 'saved') tab.value = 'all'
})

const visible = computed(() => {
  if (tab.value === 'saved') return []
  if (tab.value === 'all') return THEME_PRESETS
  return THEME_PRESETS.filter(p => p.category === tab.value)
})
</script>

<template>
  <div>
    <UTabs
      v-model="tab"
      :items="tabs"
      :content="false"
      size="xs"
      variant="link"
      :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0 grow-0' }"
      class="mb-3"
      data-testid="theme-preset-tabs"
    />
    <div
      class="grid gap-2"
      :class="columns === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'"
    >
      <slot
        name="before"
        :tab="tab"
      />
      <button
        v-for="preset in visible"
        :key="preset.id"
        type="button"
        :data-testid="`${testidPrefix}${preset.id}`"
        class="text-left rounded-md border p-1.5 bg-default hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        :class="selectedId === preset.id ? 'border-primary bg-elevated/40' : 'border-default'"
        :aria-pressed="selectedId === preset.id"
        @click="emit('select', preset)"
      >
        <div class="aspect-[3/4] rounded-sm ring-1 ring-default bg-white overflow-hidden flex flex-col">
          <img
            v-if="themeThumbnailUrl(preset.id)"
            :src="themeThumbnailUrl(preset.id) ?? undefined"
            alt=""
            loading="lazy"
            decoding="async"
            class="w-full h-full object-cover object-top"
          >
          <template v-else>
            <div
              class="h-2 shrink-0"
              :style="{ backgroundColor: preset.theme.color.brand }"
            />
            <span
              class="m-auto text-3xl text-neutral-800"
              :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
            >Aa</span>
          </template>
        </div>
        <div
          class="mt-1.5 px-0.5 text-xs font-semibold truncate"
          :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
        >
          {{ t(`theme.presets.${preset.id}.name`) }}
        </div>
        <p class="px-0.5 text-[11px] text-muted leading-snug line-clamp-2">
          {{ t(`theme.presets.${preset.id}.description`) }}
        </p>
      </button>
    </div>
  </div>
</template>
