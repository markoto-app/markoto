<script setup lang="ts">
// Publish as a web page: a static copy of the document at a public
// address (`/p/<slug>`), optionally shown on one of the user's own
// domains. Owner and workspace admins. Publishing again replaces the
// copy; the document itself keeps its access mode.
// Server: `server/api/docs/[docId]/publish/`, `server/api/user/custom-domains/`.
import type { ApiResponse } from '~/utils/api/client'

type PublishState = ApiResponse<'/api/docs/:docId/publish', 'get'>
type DomainsResponse = ApiResponse<'/api/user/custom-domains', 'get'>

const props = defineProps<{ docId: string }>()
const { t, locale } = useI18n()
const { showContextualError } = useErrorHandler()
const { customDomains: domainsOnInstance } = useInstanceConfig()
const { copy, copied } = useClipboard()

const state = ref<PublishState | null>(null)
const domains = ref<DomainsResponse | null>(null)
const busy = ref(false)
const indexableOnPublish = ref(false)
const slugInput = ref('')
const path = computed(() => ({ docId: props.docId }))

async function loadDomains(): Promise<void> {
  if (!domainsOnInstance.value) return
  try {
    domains.value = await apiFetch('/api/user/custom-domains')
  } catch {
    domains.value = null
  }
}

async function load(): Promise<void> {
  try {
    state.value = await apiFetch('/api/docs/:docId/publish', { path: path.value })
  } catch {
    state.value = null
  }
  void loadDomains()
}
onMounted(load)
watch(() => state.value?.page?.slug, (slug) => {
  slugInput.value = slug ?? ''
})

async function run(fn: () => Promise<PublishState>, errorKey: string): Promise<void> {
  busy.value = true
  try {
    state.value = await fn()
  } catch (e) {
    showContextualError(e, errorKey)
    slugInput.value = state.value?.page?.slug ?? ''
  } finally {
    busy.value = false
  }
}

function publish(): Promise<void> {
  const body = state.value?.published ? {} : { indexable: indexableOnPublish.value }
  return run(() => apiFetch('/api/docs/:docId/publish', { method: 'post', path: path.value, body }), 'publish.failed')
}
function unpublish(): Promise<void> {
  return run(async () => {
    await apiFetch('/api/docs/:docId/publish', { method: 'delete', path: path.value })
    await loadDomains()
    return { published: false, page: null }
  }, 'publish.unpublishFailed')
}
function patch(body: { slug?: string, indexable?: boolean }): Promise<void> {
  return run(() => apiFetch('/api/docs/:docId/publish', { method: 'patch', path: path.value, body }), 'publish.saveFailed')
}
function saveSlug(): void {
  const slug = slugInput.value.trim().toLowerCase()
  if (slug && slug !== state.value?.page?.slug) void patch({ slug })
}

const updatedAt = computed(() => {
  const iso = state.value?.page?.updatedAt
  return iso ? new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) : ''
})

const NO_DOMAIN = '__none__'
const verifiedDomains = computed(() => (domains.value?.domains ?? []).filter(d => d.status === 'verified'))
const currentDomain = computed(() => verifiedDomains.value.find(d => d.page?.docId === props.docId) ?? null)
const domainItems = computed(() => [
  { label: t('publish.domain.none'), value: NO_DOMAIN },
  ...verifiedDomains.value.map(d => ({ label: d.hostname, value: d.id }))
])
async function setDomain(id: string): Promise<void> {
  busy.value = true
  try {
    const previous = currentDomain.value
    if (previous && previous.id !== id) {
      await apiFetch('/api/user/custom-domains/:domainId', { method: 'patch', path: { domainId: previous.id }, body: { docId: null } })
    }
    if (id !== NO_DOMAIN) {
      await apiFetch('/api/user/custom-domains/:domainId', { method: 'patch', path: { domainId: id }, body: { docId: props.docId } })
    }
    await loadDomains()
  } catch (e) {
    showContextualError(e, 'publish.saveFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    v-if="state"
    class="space-y-3 border-t border-default pt-4"
    data-testid="publish-panel"
  >
    <div>
      <p class="block text-sm font-medium">
        {{ t('publish.title') }}
      </p>
      <p class="text-xs text-muted mt-1">
        {{ t('publish.help') }}
      </p>
    </div>

    <template v-if="!state.published">
      <USwitch
        v-model="indexableOnPublish"
        :disabled="busy"
        :label="t('publish.indexable')"
        :description="t('publish.indexableHelp')"
        data-testid="publish-indexable-new"
      />
      <UButton
        color="neutral"
        icon="i-lucide-globe"
        :loading="busy"
        data-testid="publish-submit"
        @click="publish"
      >
        {{ t('publish.publish') }}
      </UButton>
    </template>

    <template v-else-if="state.page">
      <div class="flex gap-2">
        <UInput
          :model-value="currentDomain?.url ?? state.page.url"
          readonly
          class="flex-1 font-mono text-xs"
          data-testid="publish-url"
        />
        <UButton
          color="neutral"
          variant="outline"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="t('publish.copy')"
          data-testid="publish-copy"
          @click="copy(currentDomain?.url ?? state.page.url)"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-external-link"
          :to="currentDomain?.url ?? state.page.url"
          target="_blank"
          :aria-label="t('publish.open')"
        />
      </div>
      <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted">
        {{ t('publish.updatedAt', { date: updatedAt }) }}
      </p>

      <UFormField
        :label="t('publish.address')"
        :help="t('publish.addressHelp')"
      >
        <div class="flex gap-2">
          <UInput
            v-model="slugInput"
            class="flex-1 font-mono"
            :disabled="busy"
            data-testid="publish-slug"
            @keydown.enter.prevent="saveSlug"
          >
            <template #leading>
              <span class="font-mono text-xs text-muted">/p/</span>
            </template>
          </UInput>
          <UButton
            color="neutral"
            variant="outline"
            :disabled="busy || !slugInput.trim() || slugInput.trim() === state.page.slug"
            data-testid="publish-slug-save"
            @click="saveSlug"
          >
            {{ t('common.save') }}
          </UButton>
        </div>
      </UFormField>

      <USwitch
        :model-value="state.page.indexable"
        :disabled="busy"
        :label="t('publish.indexable')"
        :description="t('publish.indexableHelp')"
        data-testid="publish-indexable"
        @update:model-value="(v: boolean) => patch({ indexable: v })"
      />

      <div
        v-if="domainsOnInstance && domains"
        class="space-y-2"
        data-testid="publish-domain"
      >
        <UFormField
          v-if="verifiedDomains.length > 0"
          :label="t('publish.domain.label')"
        >
          <USelect
            :model-value="currentDomain?.id ?? NO_DOMAIN"
            :items="domainItems"
            :disabled="busy"
            class="w-full"
            data-testid="publish-domain-select"
            @update:model-value="(v: string) => setDomain(v)"
          />
        </UFormField>
        <p class="text-xs text-muted">
          <NuxtLink
            to="/settings/domains"
            class="underline"
            data-testid="publish-domain-settings"
          >
            {{ verifiedDomains.length > 0 ? t('publish.domain.manage') : t('publish.domain.add') }}
          </NuxtLink>
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <UButton
          color="neutral"
          icon="i-lucide-refresh-cw"
          :loading="busy"
          data-testid="publish-update"
          @click="publish"
        >
          {{ t('publish.update') }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-eye-off"
          :disabled="busy"
          data-testid="publish-unpublish"
          @click="unpublish"
        >
          {{ t('publish.unpublish') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
