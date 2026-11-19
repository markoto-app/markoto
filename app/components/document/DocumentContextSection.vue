<script setup lang="ts">
import { useAddContextLink, useProjectContext, useRemoveContextLink, useSetContextScope } from '~/queries/projectContext'
import { apiFetch } from '~/utils/api/client'
import type { ContextScope } from '~~/shared/config/projectContext'

/**
 * "AI context" in the document panel. Two things:
 *
 *   - this document as project context ("bible") for its folder or its
 *     whole workspace (personal documents: all of the owner's documents);
 *   - the context documents the AI reads in THIS document: those that apply
 *     through its folder or workspace plus extra ones attached here.
 *
 * Signed-in readers only (the AI needs a sign-in). Changing either needs
 * edit rights; the server decides `canEdit` and filters the list to the
 * documents the reader may open.
 */
const props = defineProps<{
  docId: string
}>()

const { t } = useI18n()
const { showContextualError } = useErrorHandler()
const { loggedIn } = useUserSession()

const context = useProjectContext(() => props.docId)
const data = computed(() => context.data.value ?? null)
const canEdit = computed(() => data.value?.canEdit === true)

const setScope = useSetContextScope()
const addLink = useAddContextLink()
const removeLink = useRemoveContextLink()

type ScopeChoice = ContextScope | 'off'
const scopeItems = computed(() => [
  { label: t('documentPanel.context.scope.off'), value: 'off' },
  { label: t('documentPanel.context.scope.folder'), value: 'folder' },
  { label: data.value?.inWorkspace ? t('documentPanel.context.scope.workspace') : t('documentPanel.context.scope.personal'), value: 'all' }
] satisfies Array<{ label: string, value: ScopeChoice }>)

const scopeModel = computed<ScopeChoice>({
  get: () => data.value?.contextScope ?? 'off',
  set: (next) => {
    const scope = next === 'off' ? null : next
    if (scope === (data.value?.contextScope ?? null)) return
    setScope.mutateAsync({ docId: props.docId, scope }).catch(err => showContextualError(err, 'documentPanel.context.saveFailed'))
  }
})

const SOURCE_KEYS = { all: 'sourceWorkspace', folder: 'sourceFolder', link: 'sourceAttached' } as const

const applied = computed(() => data.value?.applied ?? [])
const attachedIds = computed(() => new Set((data.value?.attached ?? []).map(a => a.docId)))
// Attached documents the panel shows for removal even when the 12-document
// prompt cap left them out of `applied`.
const attachedOnly = computed(() => (data.value?.attached ?? []).filter(a => !applied.value.some(e => e.docId === a.docId)))
const atLinkLimit = computed(() => (data.value?.attached.length ?? 0) + (data.value?.hiddenAttached ?? 0) >= (data.value?.maxAttached ?? Infinity))

function sourceLabel(source: keyof typeof SOURCE_KEYS): string {
  if (source === 'all' && !data.value?.inWorkspace) return t('documentPanel.context.sourcePersonal')
  return t(`documentPanel.context.${SOURCE_KEYS[source]}`)
}

function detach(contextDocId: string) {
  removeLink.mutateAsync({ docId: props.docId, contextDocId }).catch(err => showContextualError(err, 'documentPanel.context.saveFailed'))
}

// Attach: search the documents the reader can open (the quick-search API).
interface PickItem { label: string, value: string }
const searchTerm = ref('')
const pickItems = ref<PickItem[]>([])
const picked = ref<string | undefined>(undefined)
let seq = 0
const runSearch = useDebounceFn(async (text: string) => {
  const mine = ++seq
  const q = text.trim()
  if (q === '') {
    pickItems.value = []
    return
  }
  try {
    const res = await apiFetch('/api/search/documents', { query: { q, limit: 10 } })
    if (mine !== seq) return
    pickItems.value = res.results
      .filter(r => r.docId !== props.docId && !attachedIds.value.has(r.docId))
      .map(r => ({ label: r.title || t('documentPanel.context.untitled'), value: r.docId }))
  } catch {
    if (mine === seq) pickItems.value = []
  }
}, 200)
watch(searchTerm, v => void runSearch(v))

watch(picked, (contextDocId) => {
  if (!contextDocId) return
  addLink.mutateAsync({ docId: props.docId, contextDocId })
    .catch(err => showContextualError(err, 'documentPanel.context.saveFailed'))
    .finally(() => {
      picked.value = undefined
      searchTerm.value = ''
      pickItems.value = []
    })
})
</script>

<template>
  <section
    v-if="loggedIn"
    data-testid="doc-context-section"
  >
    <div class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
      {{ t('documentPanel.context.label') }}
    </div>
    <p class="text-xs text-toned mt-1.5">
      {{ t('documentPanel.context.help') }}
    </p>

    <div
      v-if="context.isLoading.value && !data"
      class="mt-3 text-xs text-muted"
    >
      {{ t('common.loading') }}
    </div>

    <template v-else-if="data">
      <UFormField
        :label="t('documentPanel.context.scope.label')"
        :description="t('documentPanel.context.scope.help')"
        class="mt-3"
        :ui="{ label: 'text-xs text-default font-normal', description: 'text-xs text-toned mt-1', container: 'mt-1.5' }"
      >
        <USelect
          v-model="scopeModel"
          :items="scopeItems"
          :disabled="!canEdit || setScope.isLoading.value"
          class="w-full"
          data-testid="doc-context-scope"
        />
      </UFormField>

      <div class="mt-4">
        <div class="text-xs text-default">
          {{ t('documentPanel.context.appliedLabel') }}
        </div>
        <ul
          v-if="applied.length > 0 || attachedOnly.length > 0"
          class="mt-1.5 space-y-1"
          data-testid="doc-context-applied"
        >
          <li
            v-for="entry in applied"
            :key="entry.docId"
            class="flex items-center gap-2 rounded-md bg-default px-2 py-1.5"
            :data-context-doc-id="entry.docId"
          >
            <UIcon
              name="i-lucide-book-marked"
              class="size-3.5 shrink-0 text-muted"
            />
            <div class="min-w-0 flex-1">
              <NuxtLink
                :to="`/d/${entry.docId}`"
                class="block truncate text-sm text-default hover:underline"
              >
                {{ entry.title || t('documentPanel.context.untitled') }}
              </NuxtLink>
              <div class="text-[11px] text-muted">
                {{ sourceLabel(entry.source) }}
              </div>
            </div>
            <UButton
              v-if="entry.source === 'link' && canEdit"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('documentPanel.context.detach')"
              data-testid="doc-context-detach"
              @click="detach(entry.docId)"
            />
          </li>
          <li
            v-for="entry in attachedOnly"
            :key="entry.docId"
            class="flex items-center gap-2 rounded-md bg-default px-2 py-1.5"
            :data-context-doc-id="entry.docId"
          >
            <UIcon
              name="i-lucide-book-marked"
              class="size-3.5 shrink-0 text-muted"
            />
            <div class="min-w-0 flex-1">
              <NuxtLink
                :to="`/d/${entry.docId}`"
                class="block truncate text-sm text-default hover:underline"
              >
                {{ entry.title || t('documentPanel.context.untitled') }}
              </NuxtLink>
              <div class="text-[11px] text-muted">
                {{ t('documentPanel.context.notIncluded') }}
              </div>
            </div>
            <UButton
              v-if="canEdit"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('documentPanel.context.detach')"
              data-testid="doc-context-detach"
              @click="detach(entry.docId)"
            />
          </li>
        </ul>
        <p
          v-else
          class="mt-1.5 text-xs text-toned"
          data-testid="doc-context-empty"
        >
          {{ t('documentPanel.context.none') }}
        </p>
        <p
          v-if="data.omitted > 0"
          class="mt-1.5 text-xs text-toned"
        >
          {{ t('documentPanel.context.omitted', { n: data.omitted }, data.omitted) }}
        </p>
      </div>

      <UFormField
        v-if="canEdit"
        :label="t('documentPanel.context.attachLabel')"
        :description="atLinkLimit ? t('documentPanel.context.attachLimit', { max: data.maxAttached }) : t('documentPanel.context.attachHelp')"
        class="mt-4"
        :ui="{ label: 'text-xs text-default font-normal', description: 'text-xs text-toned mt-1', container: 'mt-1.5' }"
      >
        <UInputMenu
          v-model="picked"
          v-model:search-term="searchTerm"
          :items="pickItems"
          value-key="value"
          ignore-filter
          :disabled="atLinkLimit || addLink.isLoading.value"
          :placeholder="t('documentPanel.context.attachPlaceholder')"
          icon="i-lucide-search"
          class="w-full"
          data-testid="doc-context-attach"
        />
      </UFormField>
    </template>
  </section>
</template>
