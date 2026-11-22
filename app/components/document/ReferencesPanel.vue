<script setup lang="ts">
import type { CslItem } from '~~/shared/utils/citations/cslItem'
import { describeItem } from '~~/shared/utils/citations/cslItem'
import { CITATION_STYLES, formatEntryText, type CitationStyleId } from '~~/shared/utils/citations/citationStyles'
import { parseBibliographyText, BIBLIOGRAPHY_IMPORT_MAX_BYTES } from '~~/shared/utils/citations/bibImport'
import { citationKeyFor } from '~~/shared/utils/citations/citationKey'
import { documentLocale } from '~~/shared/utils/documents/documentLocale'
import type { ReferenceProblem } from '~/utils/markdown/citationResolve'
import type { AddResult } from '~/composables/document/useBibliography'

/**
 * Right-sidebar panel for the document's bibliography: the citation
 * style, adding entries (DOI lookup, pasted BibTeX / CSL JSON, a .bib /
 * .json / .yaml file from Zotero or any reference manager), the entry
 * list with "cite" and "remove", and the problems of the last preview
 * render (unknown keys, unknown or duplicate labels). The entries live in
 * Y.js (`useBibliography`), shared with every editor of the document.
 */
const props = defineProps<{
  items: readonly CslItem[]
  styleId: CitationStyleId
  language: string
  problems: readonly ReferenceProblem[]
  /** Change the bibliography (style, add, remove). */
  canEdit: boolean
  /** Insert a citation into the text (a person who must suggest cites, as a suggestion, but can't change the bibliography). */
  canCite: boolean
  /** Signed in: DOI lookup is available. */
  canLookup: boolean
  addItems: (items: readonly CslItem[]) => AddResult
  hasKey: (key: string) => boolean
}>()

const emit = defineEmits<{
  'update:styleId': [CitationStyleId]
  'remove': [key: string]
  'insert': [text: string]
  'close': []
}>()

const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const styleItems = computed(() => CITATION_STYLES.map(s => ({ label: s.label, value: s.id })))
const styleModel = computed({
  get: () => props.styleId,
  set: (v: CitationStyleId) => emit('update:styleId', v)
})

const locale = computed(() => documentLocale(props.language))

// Adding
type AddMode = 'doi' | 'paste'
const addMode = ref<AddMode | null>(null)
watch(addMode, async (mode) => {
  await nextTick()
  if (mode === 'doi') doiField.value?.inputRef?.focus()
  else if (mode === 'paste') pasteField.value?.textareaRef?.focus()
})
const doiInput = ref('')
// Opening a field puts the caret in it: Enter then submits it instead of
// pressing the (still focused) button that opened it, which closed it again.
const doiField = useTemplateRef<{ inputRef?: HTMLInputElement | null }>('doiField')
const pasteField = useTemplateRef<{ textareaRef?: HTMLTextAreaElement | null }>('pasteField')
const pasteInput = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function reportAdded(result: AddResult, skipped: number) {
  const parts = [t('references.addedCount', { n: result.added }, result.added)]
  if (result.replaced > 0) parts.push(t('references.replacedCount', { n: result.replaced }, result.replaced))
  if (skipped + result.dropped > 0) parts.push(t('references.skippedCount', { n: skipped + result.dropped }, skipped + result.dropped))
  toast.add({ title: parts.join(' '), icon: 'i-lucide-book-check', color: result.added + result.replaced > 0 ? 'success' : 'neutral' })
}

function importText(text: string): boolean {
  const parsed = parseBibliographyText(text)
  if (parsed.items.length === 0) {
    toast.add({ title: t('references.nothingFound'), icon: 'i-lucide-circle-alert', color: 'error' })
    return false
  }
  reportAdded(props.addItems(parsed.items), parsed.skipped)
  return true
}

function addPasted() {
  if (importText(pasteInput.value)) {
    pasteInput.value = ''
    addMode.value = null
  }
}

async function addDoi() {
  const doi = doiInput.value.trim()
  if (!doi || busy.value) return
  busy.value = true
  try {
    const { item } = await apiFetch('/api/citations/doi', { method: 'post', body: { doi } })
    // A DOI already in the bibliography keeps its key (and its citations).
    const existing = props.items.find(i => i.DOI && i.DOI.toLowerCase() === (item.DOI ?? '').toLowerCase())
    const id = existing?.id ?? (props.hasKey(item.id) ? citationKeyFor(item, props.hasKey) : item.id)
    reportAdded(props.addItems([{ ...item, id }]), 0)
    doiInput.value = ''
    addMode.value = null
  } catch (e) {
    showError('references.doiFailed', e)
  } finally {
    busy.value = false
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > BIBLIOGRAPHY_IMPORT_MAX_BYTES) {
    toast.add({ title: t('references.fileTooLarge'), icon: 'i-lucide-circle-alert', color: 'error' })
    return
  }
  importText(await file.text())
}

// List
const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.items
  return props.items.filter(i => i.id.toLowerCase().includes(q) || describeItem(i).toLowerCase().includes(q))
})

function preview(item: CslItem): string {
  return formatEntryText(item, props.styleId, locale.value)
}

const problemText = (p: ReferenceProblem) => t(`references.problem.${p.kind}`, { key: p.key })
</script>

<template>
  <div
    class="flex flex-col h-full bg-muted"
    data-testid="references-panel"
  >
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-book-marked"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('references.title') }}
        </h3>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mk-panel-close"
        data-testid="panel-close"
        :aria-label="t('common.close')"
        @click="emit('close')"
      />
    </div>

    <div class="flex-1 overflow-y-auto p-3 min-h-0 space-y-5">
      <section>
        <UFormField
          :label="t('references.style.label')"
          :description="t('references.style.help')"
          :ui="{ label: 'font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted', description: 'text-xs text-toned mt-1.5', container: 'mt-2' }"
        >
          <USelect
            v-model="styleModel"
            :items="styleItems"
            value-key="value"
            :disabled="!canEdit"
            class="w-full"
            data-testid="references-style"
          />
        </UFormField>
      </section>

      <section
        v-if="problems.length > 0"
        class="rounded-md border border-error/40 bg-default p-2.5 space-y-1"
        data-testid="references-problems"
      >
        <p class="text-xs font-medium text-error flex items-center gap-1.5">
          <UIcon
            name="i-lucide-triangle-alert"
            class="size-3.5"
          />
          {{ t('references.problemsTitle', { n: problems.length }, problems.length) }}
        </p>
        <ul class="text-xs text-muted space-y-0.5">
          <li
            v-for="(p, idx) in problems.slice(0, 20)"
            :key="`${p.kind}-${p.key}-${idx}`"
          >
            {{ problemText(p) }}
          </li>
        </ul>
      </section>

      <section
        v-if="canEdit"
        class="space-y-2"
      >
        <div class="flex flex-wrap gap-1.5">
          <UButton
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-search"
            :disabled="!canLookup"
            data-testid="references-add-doi"
            @click="addMode = addMode === 'doi' ? null : 'doi'"
          >
            {{ t('references.addDoi') }}
          </UButton>
          <UButton
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-clipboard-paste"
            data-testid="references-add-paste"
            @click="addMode = addMode === 'paste' ? null : 'paste'"
          >
            {{ t('references.addPaste') }}
          </UButton>
          <UButton
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-file-up"
            data-testid="references-add-file"
            @click="fileInput?.click()"
          >
            {{ t('references.addFile') }}
          </UButton>
          <input
            ref="fileInput"
            type="file"
            accept=".bib,.bibtex,.json,.yaml,.yml,application/json,text/x-bibtex"
            class="hidden"
            :aria-label="t('references.addFile')"
            data-testid="references-file-input"
            @change="onFile"
          >
        </div>
        <p
          v-if="!canLookup"
          class="text-xs text-muted"
        >
          {{ t('references.doiSignIn') }}
        </p>

        <form
          v-if="addMode === 'doi'"
          class="flex gap-1.5"
          @submit.prevent="addDoi"
        >
          <UInput
            ref="doiField"
            v-model="doiInput"
            :placeholder="t('references.doiPlaceholder')"
            class="flex-1"
            size="sm"
            data-testid="references-doi-input"
          />
          <UButton
            type="submit"
            size="sm"
            :loading="busy"
            data-testid="references-doi-submit"
          >
            {{ t('references.add') }}
          </UButton>
        </form>

        <div
          v-if="addMode === 'paste'"
          class="space-y-1.5"
        >
          <UTextarea
            ref="pasteField"
            v-model="pasteInput"
            :placeholder="t('references.pastePlaceholder')"
            :rows="6"
            class="w-full font-mono text-xs"
            data-testid="references-paste-input"
          />
          <div class="flex justify-end">
            <UButton
              size="sm"
              :disabled="!pasteInput.trim()"
              data-testid="references-paste-submit"
              @click="addPasted"
            >
              {{ t('references.add') }}
            </UButton>
          </div>
        </div>
      </section>

      <section class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
            {{ t('references.entries', { n: items.length }, items.length) }}
          </p>
        </div>
        <UInput
          v-if="items.length > 5"
          v-model="query"
          icon="i-lucide-search"
          size="sm"
          :placeholder="t('references.search')"
          class="w-full"
        />
        <p
          v-if="items.length === 0"
          class="text-xs text-muted"
        >
          {{ t('references.empty') }}
        </p>
        <ul
          class="space-y-1.5"
          data-testid="references-list"
        >
          <li
            v-for="item in filtered"
            :key="item.id"
            class="rounded-md bg-default p-2 text-xs"
            :data-key="item.id"
          >
            <div class="flex items-start justify-between gap-2">
              <code class="font-mono text-[11px] text-default break-all">@{{ item.id }}</code>
              <div class="flex shrink-0 gap-0.5">
                <UTooltip :text="t('references.cite')">
                  <UButton
                    icon="i-lucide-quote"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :disabled="!canCite"
                    :aria-label="t('references.cite')"
                    data-testid="references-cite"
                    @click="emit('insert', `[@${item.id}]`)"
                  />
                </UTooltip>
                <UTooltip :text="t('references.remove')">
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :disabled="!canEdit"
                    :aria-label="t('references.remove')"
                    @click="emit('remove', item.id)"
                  />
                </UTooltip>
              </div>
            </div>
            <p class="text-muted mt-1 leading-snug">
              {{ preview(item) }}
            </p>
          </li>
        </ul>
      </section>

      <p class="text-xs text-muted">
        {{ t('references.syntaxHelp') }}
      </p>
    </div>
  </div>
</template>
