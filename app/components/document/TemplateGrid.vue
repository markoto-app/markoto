<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { TEMPLATES, type TemplateMeta } from '~~/shared/templates'
import { templateThumbnailUrl } from '~~/shared/templates/thumbnails'
import { THEME_PRESETS, THEME_PRESET_CATEGORIES, type ThemePresetCategory } from '~~/shared/utils/theme/themePresets'
import type { DocTheme } from '~~/shared/types/theme'

/**
 * The new-document dialog's template picker: audience tabs over cards that
 * show each template's first page — its text in its design
 * (`public/template-thumbs/<id>.webp`, `make template-thumbs`). Same tabs and
 * cards as the design picker (`ThemePresetGrid.vue`, `PictureCard.vue`).
 *
 * Blank has no design of its own: the parent passes the design it will get
 * (`blankTheme`, the workspace default) — then its card shows that design's
 * swatch instead of the markoto picture. The parent's `before` slot adds
 * cards in front ("Blank in <saved design>"); with `savedTab` a "My designs"
 * tab shows only that slot.
 */
type Tab = 'all' | ThemePresetCategory | 'saved' | 'workspace'

const props = withDefaults(defineProps<{
  /** Template shown as chosen (border + aria-pressed). */
  selectedId?: string | null
  /** data-testid of each card: `${testidPrefix}${template.id}`. */
  testidPrefix: string
  savedTab?: boolean
  /** A "This workspace" tab (WP10c workspace templates) — shows only the `before` slot, first in the row. */
  workspaceTab?: boolean
  /** The design Blank gets when it is not markoto (a workspace default). */
  blankTheme?: DocTheme | null
  /** Description of the Blank card when `blankTheme` is set. */
  blankDescription?: string
}>(), { selectedId: null, savedTab: false, workspaceTab: false, blankTheme: null, blankDescription: undefined })

const emit = defineEmits<{ select: [template: TemplateMeta] }>()

const { t } = useI18n()

const tab = defineModel<Tab>('tab', { default: 'all' })

const tabs = computed<TabsItem[]>(() => [
  ...(props.workspaceTab ? [{ label: t('newDoc.designTabs.workspace'), value: 'workspace' }] : []),
  { label: t('newDoc.designTabs.all'), value: 'all' },
  ...THEME_PRESET_CATEGORIES
    .filter(c => TEMPLATES.some(tpl => tpl.category === c))
    .map(c => ({ label: t(`newDoc.designTabs.${c}`), value: c })),
  ...(props.savedTab ? [{ label: t('newDoc.designTabs.saved'), value: 'saved' }] : [])
])

watch(() => props.savedTab, (has) => {
  if (!has && tab.value === 'saved') tab.value = 'all'
})
watch(() => props.workspaceTab, (has) => {
  if (!has && tab.value === 'workspace') tab.value = 'all'
})

const visible = computed(() => {
  if (tab.value === 'saved' || tab.value === 'workspace') return []
  if (tab.value === 'all') return TEMPLATES
  return TEMPLATES.filter(tpl => tpl.category === tab.value)
})

function designOf(tpl: TemplateMeta): DocTheme | null {
  if (tpl.design === null && props.blankTheme) return props.blankTheme
  return THEME_PRESETS.find(p => p.id === (tpl.design ?? 'markoto'))?.theme ?? null
}

function card(tpl: TemplateMeta) {
  const theme = designOf(tpl)
  const blankInOwnDesign = tpl.design === null && props.blankTheme !== null
  return {
    image: blankInOwnDesign ? null : templateThumbnailUrl(tpl.id),
    brand: theme?.color.brand ?? '#000000',
    headingFont: theme?.headings.font ?? 'Inter',
    description: blankInOwnDesign && props.blankDescription ? props.blankDescription : t(tpl.descriptionKey)
  }
}
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
      data-testid="template-tabs"
    />
    <div class="grid gap-2 grid-cols-2 sm:grid-cols-3">
      <slot
        name="before"
        :tab="tab"
      />
      <DocumentPictureCard
        v-for="tpl in visible"
        :key="tpl.id"
        :testid="`${testidPrefix}${tpl.id}`"
        :name="t(tpl.labelKey)"
        :description="card(tpl).description"
        :selected="selectedId === tpl.id"
        :image="card(tpl).image"
        :brand="card(tpl).brand"
        :heading-font="card(tpl).headingFont"
        @click="emit('select', tpl)"
      />
    </div>
  </div>
</template>
