<script setup lang="ts">
import type { DocTheme, CodeTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'

/**
 * Embedded theme editor — sits in the right sidebar slot alongside the
 * activity panel. Layout-shift (not overlay) so the user can keep
 * editing the doc and watch the preview re-paginate as they tweak.
 *
 * Local draft pattern: clones `props.theme` on mount and on every
 * external change (e.g. a remote collaborator). All form controls bind
 * to the draft; deep-watch fires `update:theme` upstream which calls
 * `setTheme` (Y.js write + debounced PUT).
 */
const props = defineProps<{
  theme: DocTheme
  canEdit: boolean
}>()

const emit = defineEmits<{
  'update:theme': [DocTheme]
  'reset': []
  'close': []
}>()

const { t } = useI18n()
const toast = useToast()

const draft = ref<DocTheme>(structuredClone(toRaw(props.theme)))

// Re-clone whenever the external theme changes (initial load, remote
// edit). Without this, the panel keeps showing the old draft after a
// collaborator changes the theme out from under us.
watch(() => props.theme, (next) => {
  if (JSON.stringify(next) !== JSON.stringify(draft.value)) {
    draft.value = structuredClone(toRaw(next))
  }
}, { deep: true })

watch(draft, (next) => {
  if (JSON.stringify(next) === JSON.stringify(props.theme)) return
  emit('update:theme', structuredClone(toRaw(next)))
}, { deep: true })

// Eagerly load every picker font in a single Google Fonts request so each
// item in the font dropdowns can be rendered in its own face.
if (import.meta.client) {
  const families = THEME_FONTS
    .map(f => `family=${f.name.replace(/ /g, '+')}:wght@400;500;600;700`)
    .join('&')
  useHead({
    link: [{
      key: 'theme-font-picker-preview',
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?${families}&display=swap`
    }]
  })
}

// `slot` enables per-item template overrides — Nuxt UI v4 then exposes
// `#<slot>` (custom trigger) and `#<slot>-body` (custom body) for each
// item. Without `slot`, the named templates below are silently ignored.
const sectionItems = computed(() => [
  { value: 'page', slot: 'page', label: t('theme.section.page'), icon: 'i-lucide-file' },
  { value: 'body', slot: 'body', label: t('theme.section.body'), icon: 'i-lucide-text' },
  { value: 'headings', slot: 'headings', label: t('theme.section.headings'), icon: 'i-lucide-heading' },
  { value: 'color', slot: 'color', label: t('theme.section.color'), icon: 'i-lucide-palette' },
  { value: 'layout', slot: 'layout', label: t('theme.section.layout'), icon: 'i-lucide-columns-3' },
  { value: 'header', slot: 'header', label: t('theme.section.header'), icon: 'i-lucide-panel-top' },
  { value: 'footer', slot: 'footer', label: t('theme.section.footer'), icon: 'i-lucide-panel-bottom' },
  { value: 'code', slot: 'code', label: t('theme.section.code'), icon: 'i-lucide-code' },
  { value: 'tables', slot: 'tables', label: t('theme.section.tables'), icon: 'i-lucide-table' },
  { value: 'blocks', slot: 'blocks', label: t('theme.section.blocks'), icon: 'i-lucide-image' }
])

// Static option lists
const pageSizeItems = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'Letter (8.5 × 11 in)', value: 'Letter' },
  { label: 'Legal (8.5 × 14 in)', value: 'Legal' }
]
const orientationItems = computed(() => [
  { label: t('theme.portrait'), value: 'portrait' },
  { label: t('theme.landscape'), value: 'landscape' }
])
const columnItems = computed(() => [
  { label: `1 ${t('theme.column')}`, value: 1 },
  { label: `2 ${t('theme.columns')}`, value: 2 },
  { label: `3 ${t('theme.columns')}`, value: 3 }
])
const blockquoteItems = computed(() => [
  { label: t('theme.blockquote.border'), value: 'border' },
  { label: t('theme.blockquote.background'), value: 'background' },
  { label: t('theme.blockquote.none'), value: 'none' }
])
const textAlignItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.justify'), value: 'justify' }
])
const headingScaleItems = [
  { label: '1.067 (Minor Second)', value: 1.067 },
  { label: '1.125 (Major Second)', value: 1.125 },
  { label: '1.200 (Minor Third)', value: 1.2 },
  { label: '1.250 (Major Third)', value: 1.25 },
  { label: '1.333 (Perfect Fourth)', value: 1.333 },
  { label: '1.414 (Augmented Fourth)', value: 1.414 },
  { label: '1.500 (Perfect Fifth)', value: 1.5 }
]
const headingWeightItems = [
  { label: 'Regular (400)', value: 400 },
  { label: 'Medium (500)', value: 500 },
  { label: 'Semibold (600)', value: 600 },
  { label: 'Bold (700)', value: 700 },
  { label: 'Extra Bold (800)', value: 800 },
  { label: 'Black (900)', value: 900 }
]
const codeThemeItems = computed(() => [
  { label: 'GitHub Light', value: 'github-light' as CodeTheme },
  { label: 'GitHub Dark', value: 'github-dark' as CodeTheme },
  { label: 'Monokai', value: 'monokai' as CodeTheme },
  { label: 'Dracula', value: 'dracula' as CodeTheme },
  { label: 'Solarized Light', value: 'solarized-light' as CodeTheme },
  { label: 'Solarized Dark', value: 'solarized-dark' as CodeTheme },
  { label: t('theme.code.none'), value: 'none' as CodeTheme }
])
const tableHeaderBgItems = computed(() => [
  { label: t('theme.tables.headerBgBrand'), value: 'brand' },
  { label: t('theme.tables.headerBgMuted'), value: 'muted' },
  { label: t('theme.tables.headerBgNone'), value: 'none' }
])
const tableHeaderColorItems = computed(() => [
  { label: t('theme.tables.headerColorAuto'), value: 'auto' },
  { label: t('theme.tables.headerColorInherit'), value: 'inherit' }
])
const tableBordersItems = computed(() => [
  { label: t('theme.tables.bordersAll'), value: 'all' },
  { label: t('theme.tables.bordersHorizontal'), value: 'horizontal' },
  { label: t('theme.tables.bordersMinimal'), value: 'minimal' },
  { label: t('theme.tables.bordersNone'), value: 'none' }
])

const fontPickerItems = computed(() => [
  { type: 'label' as const, label: t('theme.fonts.sans') },
  ...THEME_FONTS.filter(f => f.category === 'sans').map(f => ({ label: f.name, value: f.name })),
  { type: 'label' as const, label: t('theme.fonts.serif') },
  ...THEME_FONTS.filter(f => f.category === 'serif').map(f => ({ label: f.name, value: f.name }))
])

// Header/footer token chips — cursor-aware insertion via data-* attrs.
const tokenChips = [
  { token: '{title}' },
  { token: '{date}' },
  { token: '{page}' },
  { token: '{pages}' }
]

const activeSlotInput = ref<HTMLInputElement | null>(null)

function insertToken(token: string) {
  const el = activeSlotInput.value
  if (!el) return
  const slot = el.dataset.slot as 'header' | 'footer' | undefined
  const position = el.dataset.position as 'left' | 'center' | 'right' | undefined
  if (!slot || !position) return

  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length
  const current = draft.value[slot][position]
  draft.value[slot][position] = current.slice(0, start) + token + current.slice(end)

  nextTick(() => {
    el.focus()
    const caret = start + token.length
    el.setSelectionRange(caret, caret)
  })
}

function doReset() {
  draft.value = structuredClone(defaultTheme)
  emit('reset')
}

function applyPreset(preset: typeof THEME_PRESETS[number]) {
  if (!props.canEdit) return
  draft.value = structuredClone(preset.theme)
  emit('update:theme', structuredClone(preset.theme))
  toast.add({
    title: t(`theme.presets.${preset.id}.name`),
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 border-b border-default flex items-center justify-between shrink-0">
      <div class="flex items-center gap-1.5">
        <UIcon name="i-lucide-palette" class="size-4 text-muted" />
        <h3 class="text-sm font-semibold">{{ t('theme.title') }}</h3>
      </div>
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" @click="emit('close')" />
    </div>

    <div class="flex-1 overflow-y-auto p-3 min-h-0">
      <div v-if="!canEdit" class="text-sm text-muted">
        {{ t('theme.readOnly') }}
      </div>

      <template v-else>
        <!-- Templates — clickable preset cards at the top of the panel. -->
        <section class="mb-4">
          <div class="flex items-baseline justify-between mb-2 px-1">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ t('theme.presets.title') }}
            </h4>
          </div>
          <div class="grid grid-cols-1 gap-2">
            <button
              v-for="preset in THEME_PRESETS"
              :key="preset.id"
              type="button"
              class="text-left rounded-md border border-default p-3 hover:border-primary hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              @click="applyPreset(preset)"
            >
              <div class="flex items-center gap-2 mb-1">
                <span class="size-3 rounded-full shrink-0" :style="{ backgroundColor: preset.theme.color.brand }" />
                <span
                  class="text-sm font-semibold truncate"
                  :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
                >
                  {{ t(`theme.presets.${preset.id}.name`) }}
                </span>
              </div>
              <p class="text-xs text-muted leading-snug line-clamp-2">
                {{ t(`theme.presets.${preset.id}.description`) }}
              </p>
            </button>
          </div>
        </section>

        <UAccordion
          :items="sectionItems"
          :default-value="[]"
          type="multiple"
          :unmount-on-hide="false"
        >
          <!-- Page -->
          <template #page-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.page.size')">
                <USelect v-model="draft.page.size" :items="pageSizeItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.page.orientation')">
                <USelect v-model="draft.page.orientation" :items="orientationItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.page.margin')" :help="t('theme.page.marginHelp')">
                <UInputNumber v-model="draft.page.margin" :min="0" :max="60" :step="1" class="w-full" />
              </UFormField>
            </div>
          </template>

          <!-- Body -->
          <template #body-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.body.font')">
                <USelectMenu v-model="draft.body.font" :items="fontPickerItems" value-key="value" class="w-full">
                  <template #item-label="{ item }">
                    <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
              <div class="grid grid-cols-2 gap-3">
                <UFormField :label="t('theme.body.size')">
                  <UInputNumber v-model="draft.body.size" :min="6" :max="24" :step="0.5" class="w-full" />
                </UFormField>
                <UFormField :label="t('theme.body.lineHeight')">
                  <UInputNumber v-model="draft.body.lineHeight" :min="0.8" :max="3" :step="0.05" class="w-full" />
                </UFormField>
              </div>
              <UFormField :label="t('theme.body.textAlign')" :help="t('theme.body.textAlignHelp')">
                <USelect v-model="draft.body.textAlign" :items="textAlignItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.body.color')">
                <UPopover>
                  <UButton color="neutral" variant="outline" class="w-full justify-start">
                    <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.body.color }" />
                    <span class="font-mono text-xs">{{ draft.body.color }}</span>
                  </UButton>
                  <template #content><UColorPicker v-model="draft.body.color" class="p-2" /></template>
                </UPopover>
              </UFormField>
              <UFormField :label="t('theme.body.background')">
                <UPopover>
                  <UButton color="neutral" variant="outline" class="w-full justify-start">
                    <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.body.background }" />
                    <span class="font-mono text-xs">{{ draft.body.background }}</span>
                  </UButton>
                  <template #content><UColorPicker v-model="draft.body.background" class="p-2" /></template>
                </UPopover>
              </UFormField>
            </div>
          </template>

          <!-- Headings -->
          <template #headings-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.headings.font')">
                <USelectMenu v-model="draft.headings.font" :items="fontPickerItems" value-key="value" class="w-full">
                  <template #item-label="{ item }">
                    <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
              <UFormField :label="t('theme.headings.scale')">
                <USelect v-model="draft.headings.scale" :items="headingScaleItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.headings.weight')">
                <USelect v-model="draft.headings.weight" :items="headingWeightItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.headings.color')" :help="t('theme.headings.colorHelp')">
                <UPopover>
                  <UButton color="neutral" variant="outline" class="w-full justify-start">
                    <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.headings.color }" />
                    <span class="font-mono text-xs">{{ draft.headings.color }}</span>
                  </UButton>
                  <template #content><UColorPicker v-model="draft.headings.color" class="p-2" /></template>
                </UPopover>
              </UFormField>
              <UFormField :label="t('theme.headings.underline')">
                <USwitch v-model="draft.headings.underline" />
              </UFormField>
            </div>
          </template>

          <!-- Color (just brand now) -->
          <template #color-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.color.brand')" :help="t('theme.color.brandHelp')">
                <UPopover>
                  <UButton color="neutral" variant="outline" class="w-full justify-start">
                    <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.color.brand }" />
                    <span class="font-mono text-xs">{{ draft.color.brand }}</span>
                  </UButton>
                  <template #content><UColorPicker v-model="draft.color.brand" class="p-2" /></template>
                </UPopover>
              </UFormField>
            </div>
          </template>

          <!-- Layout -->
          <template #layout-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.layout.columns')">
                <USelect v-model="draft.layout.columns" :items="columnItems" class="w-full" />
              </UFormField>
              <UFormField v-if="draft.layout.columns > 1" :label="t('theme.layout.columnGap')">
                <UInputNumber v-model="draft.layout.columnGap" :min="0" :max="30" :step="1" class="w-full" />
              </UFormField>
            </div>
          </template>

          <!-- Header -->
          <template #header-body>
            <div class="space-y-3 pt-2 pb-4">
              <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
              <UFormField :label="t('theme.runningSlots.left')">
                <UInput
                  v-model="draft.header.left"
                  class="w-full"
                  data-slot="header" data-position="left"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.center')">
                <UInput
                  v-model="draft.header.center"
                  class="w-full"
                  data-slot="header" data-position="center"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.right')">
                <UInput
                  v-model="draft.header.right"
                  class="w-full"
                  data-slot="header" data-position="right"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <div class="flex flex-wrap gap-1.5 pt-1">
                <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
                <UButton
                  v-for="chip in tokenChips"
                  :key="`hdr-${chip.token}`"
                  size="xs" color="neutral" variant="soft"
                  @mousedown.prevent
                  @click="insertToken(chip.token)"
                >
                  {{ chip.token }}
                </UButton>
              </div>
            </div>
          </template>

          <!-- Footer -->
          <template #footer-body>
            <div class="space-y-3 pt-2 pb-4">
              <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
              <UFormField :label="t('theme.runningSlots.left')">
                <UInput
                  v-model="draft.footer.left"
                  class="w-full"
                  data-slot="footer" data-position="left"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.center')">
                <UInput
                  v-model="draft.footer.center"
                  class="w-full"
                  data-slot="footer" data-position="center"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.right')">
                <UInput
                  v-model="draft.footer.right"
                  class="w-full"
                  data-slot="footer" data-position="right"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <div class="flex flex-wrap gap-1.5 pt-1">
                <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
                <UButton
                  v-for="chip in tokenChips"
                  :key="`ftr-${chip.token}`"
                  size="xs" color="neutral" variant="soft"
                  @mousedown.prevent
                  @click="insertToken(chip.token)"
                >
                  {{ chip.token }}
                </UButton>
              </div>
            </div>
          </template>

          <!-- Code -->
          <template #code-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.code.theme')">
                <USelect v-model="draft.code.theme" :items="codeThemeItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.code.fontSize')">
                <UInputNumber v-model="draft.code.fontSize" :min="6" :max="16" :step="0.5" class="w-full" />
              </UFormField>
            </div>
          </template>

          <!-- Tables -->
          <template #tables-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.tables.headerBackground')">
                <USelect v-model="draft.tables.headerBackground" :items="tableHeaderBgItems" class="w-full" />
              </UFormField>
              <UFormField
                v-if="draft.tables.headerBackground !== 'none'"
                :label="t('theme.tables.headerTextColor')"
                :help="t('theme.tables.headerTextColorHelp')"
              >
                <USelect v-model="draft.tables.headerTextColor" :items="tableHeaderColorItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.tables.borders')">
                <USelect v-model="draft.tables.borders" :items="tableBordersItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.tables.zebra')" :help="t('theme.tables.zebraHelp')">
                <USwitch v-model="draft.tables.zebra" />
              </UFormField>
              <UFormField :label="t('theme.tables.cellPadding')">
                <UInputNumber v-model="draft.tables.cellPadding" :min="0" :max="24" :step="1" class="w-full" />
              </UFormField>
            </div>
          </template>

          <!-- Blocks (images + quotes) -->
          <template #blocks-body>
            <div class="space-y-4 pt-2 pb-4">
              <div class="grid grid-cols-2 gap-3">
                <UFormField :label="t('theme.blocks.imageRadius')">
                  <UInputNumber v-model="draft.blocks.imageRadius" :min="0" :max="32" :step="1" class="w-full" />
                </UFormField>
                <UFormField :label="t('theme.blocks.imageMaxWidth')">
                  <UInputNumber v-model="draft.blocks.imageMaxWidth" :min="10" :max="100" :step="5" class="w-full" />
                </UFormField>
              </div>
              <UFormField :label="t('theme.blocks.blockquoteStyle')">
                <USelect v-model="draft.blocks.blockquoteStyle" :items="blockquoteItems" class="w-full" />
              </UFormField>
            </div>
          </template>
        </UAccordion>
      </template>
    </div>

    <div v-if="canEdit" class="p-3 border-t border-default shrink-0">
      <UButton block color="neutral" variant="outline" icon="i-lucide-rotate-ccw" @click="doReset">
        {{ t('theme.reset') }}
      </UButton>
    </div>
  </div>
</template>
