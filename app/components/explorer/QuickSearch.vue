<script setup lang="ts">
import { splitSnippet } from '~~/shared/utils/documents/searchQuery'

// Quick search (Ctrl/Cmd+K): titles and text of every document the person
// can reach: personal ones, their workspaces, documents shared with them.
// Arrow keys pick a result, Enter opens it.

const { t } = useI18n()
const router = useRouter()
const open = ref(false)
const q = ref('')
type Hit = { docId: string, title: string, workspaceName: string | null, snippet: string }
const results = ref<Hit[]>([])
const active = ref(0)
const loading = ref(false)

defineShortcuts({
  meta_k: {
    usingInput: true,
    handler: () => { open.value = !open.value }
  }
})

const input = useTemplateRef<{ inputRef?: HTMLInputElement }>('input')
watch(open, async (v) => {
  if (!v) return
  q.value = ''
  results.value = []
  active.value = 0
  await nextTick()
  input.value?.inputRef?.focus()
})

let seq = 0
const search = useDebounceFn(async (text: string) => {
  const mine = ++seq
  if (text.trim() === '') {
    results.value = []
    return
  }
  loading.value = true
  try {
    const res = await apiFetch('/api/search/documents', { query: { q: text.trim(), limit: 20 } })
    if (mine === seq) {
      results.value = res.results
      active.value = 0
    }
  } catch {
    if (mine === seq) results.value = []
  } finally {
    if (mine === seq) loading.value = false
  }
}, 200)
watch(q, v => void search(v))

function go(hit: Hit | undefined) {
  if (!hit) return
  open.value = false
  void router.push(`/d/${hit.docId}`)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = Math.min(results.value.length - 1, active.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = Math.max(0, active.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    go(results.value[active.value])
  }
}
</script>

<template>
  <UButton
    icon="i-lucide-search"
    color="neutral"
    variant="ghost"
    size="sm"
    :aria-label="t('explorer.quickSearch.open')"
    data-testid="quick-search-open"
    @click="open = true"
  >
    <span class="hidden md:inline text-muted">{{ t('explorer.quickSearch.open') }}</span>
    <UKbd
      class="hidden md:inline-flex"
      value="meta"
    />
    <UKbd
      class="hidden md:inline-flex"
      value="K"
    />
  </UButton>
  <UModal
    v-model:open="open"
    :title="t('explorer.quickSearch.open')"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div
        class="space-y-3"
        data-testid="quick-search"
      >
        <UInput
          ref="input"
          v-model="q"
          icon="i-lucide-search"
          class="w-full"
          :loading="loading"
          :placeholder="t('explorer.quickSearch.placeholder')"
          role="combobox"
          aria-controls="quick-search-results"
          :aria-expanded="results.length > 0"
          :aria-activedescendant="results.length > 0 ? `quick-search-result-${active}` : undefined"
          @keydown="onKey"
        />
        <p
          v-if="q.trim() === ''"
          class="text-xs text-muted"
        >
          {{ t('explorer.quickSearch.hint') }}
        </p>
        <ul
          v-else
          id="quick-search-results"
          role="listbox"
          class="max-h-96 overflow-y-auto space-y-0.5"
        >
          <li
            v-for="(hit, i) in results"
            :id="`quick-search-result-${i}`"
            :key="hit.docId"
            role="option"
            :aria-selected="i === active"
          >
            <NuxtLink
              :to="`/d/${hit.docId}`"
              class="block rounded-md px-2 py-1.5"
              :class="i === active ? 'bg-elevated' : 'hover:bg-elevated'"
              tabindex="-1"
              data-testid="quick-search-result"
              @click="open = false"
            >
              <span class="flex items-center gap-2 min-w-0">
                <UIcon
                  name="i-lucide-file-text"
                  class="size-4 text-muted shrink-0"
                />
                <span class="truncate text-sm">{{ hit.title }}</span>
                <span class="text-xs text-muted shrink-0 ml-auto">{{ hit.workspaceName ?? t('explorer.quickSearch.personal') }}</span>
              </span>
              <span
                v-if="hit.snippet"
                class="block text-xs text-muted truncate pl-6"
              >
                <template
                  v-for="(part, j) in splitSnippet(hit.snippet)"
                  :key="j"
                >
                  <mark
                    v-if="part.match"
                    class="bg-transparent text-default font-medium"
                  >{{ part.text }}</mark>
                  <template v-else>
                    {{ part.text }}
                  </template>
                </template>
              </span>
            </NuxtLink>
          </li>
          <li
            v-if="!loading && results.length === 0"
            class="text-sm text-muted px-2 py-3"
          >
            {{ t('explorer.quickSearch.empty') }}
          </li>
        </ul>
      </div>
    </template>
  </UModal>
</template>
