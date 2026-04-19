<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'

/**
 * Owner-only theme editor. Lives in a USlideover so the right pane
 * (paged.js preview) stays visible while the user tweaks knobs — every
 * change applies live via `setTheme`, so the user sees pagination shift
 * in real time.
 *
 * Local draft pattern: when the slideover opens, we deep-clone
 * `theme.value` into `draft`. All form controls bind to `draft`. A
 * deep-watch on `draft` fires `setTheme(draft)` (debounced inside
 * useDocument's persistTheme — typing fast doesn't spam PUTs).
 *
 * Why not bind controls directly to `theme.value`: it's `readonly()`,
 * and we'd be writing through the proxy on every keystroke. Local draft
 * + watch is cheaper and lets us add a "Discard changes" button later
 * if we want one.
 */
const props = defineProps<{
  theme: DocTheme
  // True when the current user has theme write access — owners always,
  // and any visitor on an ownerless (anonymous-created) doc since that
  // doc's whole access model is "anyone can change anything".
  canEdit: boolean
}>()

const emit = defineEmits<{
  'update:theme': [DocTheme]
  'reset': []
}>()

const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()

// Working draft. Re-cloned every time the slideover opens so external
// edits made between sessions are picked up. structuredClone preserves
// nested object shape (DocTheme has page/typography/color/layout/...).
const draft = ref<DocTheme>(structuredClone(toRaw(props.theme)))

watch(open, (isOpen) => {
  if (isOpen) {
    draft.value = structuredClone(toRaw(props.theme))
  }
})

// Push live edits up. Deep watch — every nested field counts.
// useDebounceFn covers the DB write side (in useDocument.persistTheme),
// but the in-doc Y.Map write fires immediately so collaborators see
// changes with no perceptible lag. Bypass the very first invocation
// (immediate run on watcher attach) by comparing against props.theme.
watch(draft, (next) => {
  if (JSON.stringify(next) === JSON.stringify(props.theme)) return
  emit('update:theme', structuredClone(toRaw(next)))
}, { deep: true })

// Sections — UAccordion items. `open` defaults to all so the user can
// see everything at once when the panel opens (a closed-everything
// default reads as "what now?"). Per-section state lives in the
// component for free.
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

// Items for select inputs. Built as computed so i18n switching reapplies.
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
const headingScaleItems = [
  { label: '1.067 (Minor Second)', value: 1.067 },
  { label: '1.125 (Major Second)', value: 1.125 },
  { label: '1.200 (Minor Third)', value: 1.2 },
  { label: '1.250 (Major Third)', value: 1.25 },
  { label: '1.333 (Perfect Fourth)', value: 1.333 },
  { label: '1.414 (Augmented Fourth)', value: 1.414 },
  { label: '1.500 (Perfect Fifth)', value: 1.5 }
]

// Font picker items. We pre-group sans / serif so the dropdown reads
// like a curated list, not a flat alphabetical mush.
const fontPickerItems = computed(() => [
  { type: 'label' as const, label: t('theme.fonts.sans') },
  ...THEME_FONTS.filter(f => f.category === 'sans').map(f => ({ label: f.name, value: f.name })),
  { type: 'label' as const, label: t('theme.fonts.serif') },
  ...THEME_FONTS.filter(f => f.category === 'serif').map(f => ({ label: f.name, value: f.name }))
])

// Header/footer template tokens — clickable chips that insert the token
// into the focused input. We track which input was last focused so the
// chip click knows where to insert.
const tokenChips = [
  { token: '{title}', labelKey: 'theme.token.title' },
  { token: '{date}', labelKey: 'theme.token.date' },
  { token: '{page}', labelKey: 'theme.token.page' },
  { token: '{pages}', labelKey: 'theme.token.pages' }
]

function insertToken(slot: 'header' | 'footer', position: 'left' | 'center' | 'right', token: string) {
  const current = draft.value[slot][position]
  draft.value[slot][position] = current + token
}

function doReset() {
  draft.value = structuredClone(defaultTheme)
  emit('reset')
}

function dismiss() {
  open.value = false
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('theme.title')"
    :description="t('theme.description')"
    :ui="{ content: 'sm:max-w-md' }"
  >
    <template #body>
      <div v-if="!canEdit" class="text-sm text-muted">
        {{ t('theme.readOnly') }}
      </div>

      <UAccordion
        v-else
        :items="sectionItems"
        :default-value="['page', 'typography', 'color']"
        type="multiple"
        :unmount-on-hide="false"
      >
        <!-- Page -->
        <template #page-body>
          <div class="space-y-4 pt-2">
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

        <!-- Typography -->
        <template #typography-body>
          <div class="space-y-4 pt-2">
            <UFormField :label="t('theme.typography.bodyFont')">
              <USelectMenu v-model="draft.typography.bodyFont" :items="fontPickerItems" value-key="value" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.typography.headingFont')">
              <USelectMenu v-model="draft.typography.headingFont" :items="fontPickerItems" value-key="value" class="w-full" />
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
            <UFormField :label="t('theme.typography.headingUnderline')">
              <USwitch v-model="draft.typography.headingUnderline" />
            </UFormField>
          </div>
        </template>

        <!-- Color -->
        <template #color-body>
          <div class="space-y-4 pt-2">
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

        <!-- Layout -->
        <template #layout-body>
          <div class="space-y-4 pt-2">
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
          <div class="space-y-3 pt-2">
            <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
            <UFormField :label="t('theme.runningSlots.left')">
              <UInput v-model="draft.header.left" class="w-full" placeholder="" />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.center')">
              <UInput v-model="draft.header.center" class="w-full" placeholder="" />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.right')">
              <UInput v-model="draft.header.right" class="w-full" placeholder="" />
            </UFormField>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
              <UButton
                v-for="chip in tokenChips"
                :key="`hdr-${chip.token}`"
                size="xs"
                color="neutral"
                variant="soft"
                @click="insertToken('header', 'left', chip.token)"
              >
                {{ chip.token }}
              </UButton>
            </div>
          </div>
        </template>

        <!-- Footer -->
        <template #footer-body>
          <div class="space-y-3 pt-2">
            <p class="text-xs text-muted">{{ t('theme.runningSlots.help') }}</p>
            <UFormField :label="t('theme.runningSlots.left')">
              <UInput v-model="draft.footer.left" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.center')">
              <UInput v-model="draft.footer.center" class="w-full" />
            </UFormField>
            <UFormField :label="t('theme.runningSlots.right')">
              <UInput v-model="draft.footer.right" class="w-full" />
            </UFormField>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
              <UButton
                v-for="chip in tokenChips"
                :key="`ftr-${chip.token}`"
                size="xs"
                color="neutral"
                variant="soft"
                @click="insertToken('footer', 'center', chip.token)"
              >
                {{ chip.token }}
              </UButton>
            </div>
          </div>
        </template>

        <!-- Blocks -->
        <template #blocks-body>
          <div class="space-y-4 pt-2">
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

    <template #footer>
      <div class="flex items-center justify-between w-full">
        <UButton
          v-if="canEdit"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          @click="doReset"
        >
          {{ t('theme.reset') }}
        </UButton>
        <span v-else />
        <UButton color="primary" @click="dismiss">
          {{ t('common.close') }}
        </UButton>
      </div>
    </template>
  </USlideover>
</template>
