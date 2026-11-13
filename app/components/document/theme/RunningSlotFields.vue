<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { runningRule } from '~~/shared/utils/theme/themeOptions'

// The three slots of the running header or footer, the token chips and the
// rule. A chip inserts its token into the slot input focused last, of
// either section: so the focus and the insertion go up to the panel.
const props = defineProps<{
  /** Which running area: `data-slot` of the inputs (the panel's token insertion reads it). */
  part: 'header' | 'footer'
}>()
const emit = defineEmits<{
  'slot-focus': [input: HTMLInputElement]
  'insert-token': [token: string]
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

// Header/footer token chips: cursor-aware insertion via data-* attrs.
const tokenChips = [
  { token: '{title}' },
  { token: '{section}' },
  { token: '{author}' },
  { token: '{date}' },
  { token: '{page}' },
  { token: '{pages}' }
]
const ruleModel = computed({
  get: () => runningRule(theme.value[props.part]),
  set: (v: boolean) => { theme.value[props.part].rule = v }
})
</script>

<template>
  <p class="text-xs text-muted">
    {{ t('theme.runningSlots.help') }}
  </p>
  <UFormField :label="t('theme.runningSlots.left')">
    <UInput
      v-model="theme[part].left"
      class="w-full"
      :data-slot="part"
      data-position="left"
      @focus="(e: FocusEvent) => emit('slot-focus', e.target as HTMLInputElement)"
    />
  </UFormField>
  <UFormField :label="t('theme.runningSlots.center')">
    <UInput
      v-model="theme[part].center"
      class="w-full"
      :data-slot="part"
      data-position="center"
      @focus="(e: FocusEvent) => emit('slot-focus', e.target as HTMLInputElement)"
    />
  </UFormField>
  <UFormField :label="t('theme.runningSlots.right')">
    <UInput
      v-model="theme[part].right"
      class="w-full"
      :data-slot="part"
      data-position="right"
      @focus="(e: FocusEvent) => emit('slot-focus', e.target as HTMLInputElement)"
    />
  </UFormField>
  <div class="flex flex-wrap gap-1.5 pt-1">
    <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
    <UButton
      v-for="chip in tokenChips"
      :key="`${part}-${chip.token}`"
      size="xs"
      color="neutral"
      variant="soft"
      @mousedown.prevent
      @click="emit('insert-token', chip.token)"
    >
      {{ chip.token }}
    </UButton>
  </div>
  <UFormField
    :label="t(part === 'header' ? 'theme.runningSlots.ruleHeader' : 'theme.runningSlots.ruleFooter')"
    :help="t('theme.runningSlots.ruleHelp')"
  >
    <USwitch
      v-model="ruleModel"
      :data-testid="`theme-${part}-rule`"
    />
  </UFormField>
</template>
