<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { resolveTitleBlock } from '~~/shared/utils/theme/themeOptions'

// The cover's authors, each with an optional affiliation (title block),
// up to ten. Used by the cover section and by the locked-design view.
const props = defineProps<{
  /** Give each affiliation field a `data-testid` (the cover section's). */
  affiliationTestids?: boolean
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const MAX_AUTHORS = 10

function addAuthor() {
  if (theme.value.cover.authors.length >= MAX_AUTHORS) return
  theme.value.cover.authors = [...theme.value.cover.authors, '']
}
function removeAuthor(idx: number) {
  theme.value.cover.authors = theme.value.cover.authors.filter((_, i) => i !== idx)
  const affiliations = theme.value.cover.affiliations
  if (affiliations) theme.value.cover.affiliations = affiliations.filter((_, i) => i !== idx)
}

// `cover.affiliations` is optional (absent in themes stored before it
// existed): read through its default, written only when the user changes
// it: opening the panel must not rewrite the document's theme.
function affiliationAt(idx: number): string {
  return resolveTitleBlock(theme.value).affiliations[idx] ?? ''
}
function setAffiliation(idx: number, value: string | number) {
  const next = [...resolveTitleBlock(theme.value).affiliations]
  while (next.length < theme.value.cover.authors.length) next.push('')
  next[idx] = String(value)
  theme.value.cover.affiliations = next.slice(0, theme.value.cover.authors.length)
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="(_, idx) in theme.cover.authors"
      :key="idx"
      class="flex gap-2"
    >
      <div class="flex-1 space-y-1">
        <UInput
          v-model="theme.cover.authors[idx]"
          :placeholder="t('theme.cover.authorPlaceholder')"
          maxlength="100"
          class="w-full"
        />
        <UTextarea
          :model-value="affiliationAt(idx)"
          :placeholder="t('theme.cover.affiliationPlaceholder')"
          :rows="2"
          autoresize
          maxlength="300"
          class="w-full"
          :data-testid="props.affiliationTestids ? `theme-cover-affiliation-${idx}` : undefined"
          @update:model-value="setAffiliation(idx, $event)"
        />
      </div>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :aria-label="t('theme.cover.removeAuthor')"
        @click="removeAuthor(idx)"
      />
    </div>
    <UButton
      v-if="theme.cover.authors.length < MAX_AUTHORS"
      color="neutral"
      variant="outline"
      icon="i-lucide-plus"
      block
      @click="addAuthor"
    >
      {{ t('theme.cover.addAuthor') }}
    </UButton>
  </div>
</template>
