<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'

// Eagerly load every picker font in a single Google Fonts request so each
// item in the font dropdowns can be rendered in its own face. Done via
// useHead so Nuxt manages the <link> across page navigations and dedupes
// it across multiple panel mounts. Only fires client-side (head injection
// during SSR would block the doc shell on a third-party stylesheet).
if (import.meta.client) {
  const families = THEME_FONTS
    .map(f => `family=${f.name.replace(/ /g, '+')}:wght@400;500;600;700`)
    .join('&')
  useHead({
    link: [{
      key: 'theme-font-picker-preview',     // dedupe key — Nuxt won't add twice
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?${families}&display=swap`
    }]
  })
}

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
  // True when the current user has theme write access — owners always,
  // and any visitor on an ownerless (anonymous-created) doc.
  canEdit: boolean
}>()

const emit = defineEmits<{
  'update:theme': [DocTheme]
  'reset': []
  'close': []
}>()

const { t } = useI18n()

const draft = ref<DocTheme>(structuredClone(toRaw(props.theme)))

// Re-clone whenever the external theme changes (initial load, remote
// edit). Without this the panel keeps showing the old draft after a
// collaborator changes the theme out from under us.
watch(() => props.theme, (next) => {
  if (JSON.stringify(next) !== JSON.stringify(draft.value)) {
    draft.value = structuredClone(toRaw(next))
  }
}, { deep: true })

// Push live edits up. Skip the no-op case where draft already matches
// props (covers the initial mount + the re-clone watcher above).
watch(draft, (next) => {
  if (JSON.stringify(next) === JSON.stringify(props.theme)) return
  emit('update:theme', structuredClone(toRaw(next)))
}, { deep: true })

// `slot` enables per-item template overrides — Nuxt UI v4 then exposes
// `#<slot>` (custom trigger) and `#<slot>-body` (custom body) for each
// item. Without `slot`, the named templates below are silently ignored
// and the accordion bodies render empty.
const sectionItems = computed(() => [
  { value: 'page', slot: 'page', label: t('theme.section.page'), icon: 'i-lucide-file' },
  { value: 'typography', slot: 'typography', label: t('theme.section.typography'), icon: 'i-lucide-type' },
  { value: 'color', slot: 'color', label: t('theme.section.color'), icon: 'i-lucide-palette' },
  { value: 'layout', slot: 'layout', label: t('theme.section.layout'), icon: 'i-lucide-columns-3' },
  { value: 'header', slot: 'header', label: t('theme.section.header'), icon: 'i-lucide-panel-top' },
  { value: 'footer', slot: 'footer', label: t('theme.section.footer'), icon: 'i-lucide-panel-bottom' },
  { value: 'blocks', slot: 'blocks', label: t('theme.section.blocks'), icon: 'i-lucide-image' }
])

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
const codeBlockItems = computed(() => [
  { label: t('theme.code.light'), value: 'light' },
  { label: t('theme.code.dark'), value: 'dark' },
  { label: t('theme.code.none'), value: 'none' }
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
const fontPickerItems = computed(() => [
  { type: 'label' as const, label: t('theme.fonts.sans') },
  ...THEME_FONTS.filter(f => f.category === 'sans').map(f => ({ label: f.name, value: f.name })),
  { type: 'label' as const, label: t('theme.fonts.serif') },
  ...THEME_FONTS.filter(f => f.category === 'serif').map(f => ({ label: f.name, value: f.name }))
])

const tokenChips = [
  { token: '{title}' },
  { token: '{date}' },
  { token: '{page}' },
  { token: '{pages}' }
]

// Track the most-recently-focused header/footer input so a chip click
// can insert into the right slot+position. Inputs identify themselves
// via `data-slot` / `data-position` so the dispatch stays declarative
// instead of needing one ref per input.
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

  // Restore focus + place caret right after the inserted token.
  // Wait one tick so Vue's reactivity has flushed the new value.
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

const toast = useToast()

// Apply a built-in preset. Replaces the entire draft (presets are
// complete themes, not partial overrides) and emits up so the live
// theme + DB persist via the same path as a manual edit. The deep
// watcher below picks up the swap and fires `update:theme`, but we
// also call emit explicitly to keep behavior identical even if the
// JSON.stringify equality check ever short-circuits the watcher.
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
    <!-- Panel header — mirrors the activity feed header pattern so the
         right sidebar reads consistently regardless of which slot is open. -->
    <div class="p-3 border-b border-default flex items-center justify-between shrink-0">
      <div class="flex items-center gap-1.5">
        <UIcon name="i-lucide-palette" class="size-4 text-muted" />
        <h3 class="text-sm font-semibold">{{ t('theme.title') }}</h3>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        @click="emit('close')"
      />
    </div>

    <!-- Body — scrollable; flex-1 so the form fills the remaining height. -->
    <div class="flex-1 overflow-y-auto p-3 min-h-0">
      <div v-if="!canEdit" class="text-sm text-muted">
        {{ t('theme.readOnly') }}
      </div>

      <template v-else>
        <!-- Templates — clickable preset cards at the top of the panel.
             Each card shows the brand color + body font in their own
             face so the user gets a visual sense of the look without
             applying it. Tap a card → entire theme swaps. -->
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
                <span
                  class="size-3 rounded-full shrink-0"
                  :style="{ backgroundColor: preset.theme.color.brand }"
                />
                <span
                  class="text-sm font-semibold truncate"
                  :style="{ fontFamily: `'${preset.theme.typography.headingFont}', system-ui, sans-serif` }"
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

        <template #typography-body>
          <div class="space-y-4 pt-2 pb-4">
            <UFormField :label="t('theme.typography.bodyFont')">
              <USelectMenu v-model="draft.typography.bodyFont" :items="fontPickerItems" value-key="value" class="w-full">
                <!-- Render each label in its own typeface so the user
                     sees the actual look of every option. The Google
                     Fonts request injected at script load covers every
                     value in THEME_FONTS, so any item with `value` set
                     resolves to a real face (the section-label items
                     have no value and fall back to system UI). -->
                <template #item-label="{ item }">
                  <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">
                    {{ item.label }}
                  </span>
                </template>
              </USelectMenu>
            </UFormField>
            <UFormField :label="t('theme.typography.headingFont')">
              <USelectMenu v-model="draft.typography.headingFont" :items="fontPickerItems" value-key="value" class="w-full">
                <template #item-label="{ item }">
                  <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">
                    {{ item.label }}
                  </span>
                </template>
              </USelectMenu>
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('theme.typography.bodySize')">
                <UInputNumber v-model="draft.typography.bodySize" :min="6" :max="24" :step="0.5" class="w-full" />
              </UFormField>
              <UFormField :label="t('theme.typography.lineHeight')">
                <UInputNumber v-model="draft.typography.lineHeight" :min="0.8" :max="3" :step="0.05" class="w-full" />
              </UFormField>
            </div>
            <UFormField :label="t('theme.typography.headingScale')">
              <USelect v-model="draft.typography.headingScale" :items="headingScaleItems" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.typography.textAlign')" :help="t('theme.typography.textAlignHelp')">
              <USelect v-model="draft.typography.textAlign" :items="textAlignItems" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.typography.headingUnderline')">
              <USwitch v-model="draft.typography.headingUnderline" />
            </UFormField>
          </div>
        </template>

        <template #color-body>
          <div class="space-y-4 pt-2 pb-4">
            <UFormField :label="t('theme.color.brand')" :help="t('theme.color.brandHelp')">
              <UPopover>
                <UButton color="neutral" variant="outline" class="w-full justify-start">
                  <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.color.brand }" />
                  <span class="font-mono text-xs">{{ draft.color.brand }}</span>
                </UButton>
                <template #content>
                  <UColorPicker v-model="draft.color.brand" class="p-2" />
                </template>
              </UPopover>
            </UFormField>
            <UFormField :label="t('theme.color.text')">
              <UPopover>
                <UButton color="neutral" variant="outline" class="w-full justify-start">
                  <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.color.text }" />
                  <span class="font-mono text-xs">{{ draft.color.text }}</span>
                </UButton>
                <template #content>
                  <UColorPicker v-model="draft.color.text" class="p-2" />
                </template>
              </UPopover>
            </UFormField>
            <UFormField :label="t('theme.color.background')">
              <UPopover>
                <UButton color="neutral" variant="outline" class="w-full justify-start">
                  <span class="size-4 rounded border border-default" :style="{ backgroundColor: draft.color.background }" />
                  <span class="font-mono text-xs">{{ draft.color.background }}</span>
                </UButton>
                <template #content>
                  <UColorPicker v-model="draft.color.background" class="p-2" />
                </template>
              </UPopover>
            </UFormField>
          </div>
        </template>

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

        <template #header-body>
          <div class="space-y-3 pt-2 pb-4">
            <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
            <UFormField :label="t('theme.runningSlots.left')">
              <UInput
                v-model="draft.header.left"
                class="w-full"
                data-slot="header"
                data-position="left"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.center')">
              <UInput
                v-model="draft.header.center"
                class="w-full"
                data-slot="header"
                data-position="center"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.right')">
              <UInput
                v-model="draft.header.right"
                class="w-full"
                data-slot="header"
                data-position="right"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
              <UButton
                v-for="chip in tokenChips"
                :key="`hdr-${chip.token}`"
                size="xs"
                color="neutral"
                variant="soft"
                @mousedown.prevent
                @click="insertToken(chip.token)"
              >
                {{ chip.token }}
              </UButton>
            </div>
          </div>
        </template>

        <template #footer-body>
          <div class="space-y-3 pt-2 pb-4">
            <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
            <UFormField :label="t('theme.runningSlots.left')">
              <UInput
                v-model="draft.footer.left"
                class="w-full"
                data-slot="footer"
                data-position="left"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.center')">
              <UInput
                v-model="draft.footer.center"
                class="w-full"
                data-slot="footer"
                data-position="center"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.right')">
              <UInput
                v-model="draft.footer.right"
                class="w-full"
                data-slot="footer"
                data-position="right"
                @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
              />
            </UFormField>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
              <UButton
                v-for="chip in tokenChips"
                :key="`ftr-${chip.token}`"
                size="xs"
                color="neutral"
                variant="soft"
                @mousedown.prevent
                @click="insertToken(chip.token)"
              >
                {{ chip.token }}
              </UButton>
            </div>
          </div>
        </template>

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
            <UFormField :label="t('theme.blocks.codeBlockTheme')">
              <USelect v-model="draft.blocks.codeBlockTheme" :items="codeBlockItems" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.blocks.blockquoteStyle')">
              <USelect v-model="draft.blocks.blockquoteStyle" :items="blockquoteItems" class="w-full" />
            </UFormField>
          </div>
        </template>
        </UAccordion>
      </template>
    </div>

    <!-- Footer — Reset button (only when editable) -->
    <div v-if="canEdit" class="p-3 border-t border-default shrink-0">
      <UButton
        block
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        @click="doReset"
      >
        {{ t('theme.reset') }}
      </UButton>
    </div>
  </div>
</template>
