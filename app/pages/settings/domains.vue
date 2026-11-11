<script setup lang="ts">
// Custom domains: show a published page at the user's own
// address. Add a domain → set the two DNS records shown here → the check
// passes (automatically every few minutes, or "Check now") → pick the
// page in the document's share dialog. Modal-style page like
// /settings/ai; the endpoints are session-only.

import type { ApiResponse } from '~/utils/api/client'

type DomainsResponse = ApiResponse<'/api/user/custom-domains', 'get'>
type DomainView = DomainsResponse['domains'][number]

const router = useRouter()
const { t, locale } = useI18n()
const { loggedIn } = useUserSession()
const { primaryLoginPath, customDomains: domainsOnInstance } = useInstanceConfig()
const { showContextualError } = useErrorHandler()
const { copy } = useClipboard()

useHead({ title: () => t('customDomains.title') })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) router.back()
  else router.push('/')
}

const data = ref<DomainsResponse | null>(null)
const loading = ref(false)
const busyId = ref<string | null>(null)
const hostname = ref('')
const adding = ref(false)

async function load(): Promise<void> {
  if (!loggedIn.value || !domainsOnInstance.value) return
  loading.value = true
  try {
    data.value = await apiFetch('/api/user/custom-domains')
  } catch (e) {
    showContextualError(e, 'customDomains.loadFailed')
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function add(): Promise<void> {
  if (!hostname.value.trim()) return
  adding.value = true
  try {
    await apiFetch('/api/user/custom-domains', { method: 'post', body: { hostname: hostname.value } })
    hostname.value = ''
    await load()
  } catch (e) {
    showContextualError(e, 'customDomains.addFailed')
  } finally {
    adding.value = false
  }
}

async function check(d: DomainView): Promise<void> {
  busyId.value = d.id
  try {
    const next = await apiFetch('/api/user/custom-domains/:domainId/verify', { method: 'post', path: { domainId: d.id } })
    if (data.value) data.value.domains = data.value.domains.map(x => x.id === d.id ? next : x)
  } catch (e) {
    showContextualError(e, 'customDomains.checkFailed')
  } finally {
    busyId.value = null
  }
}

async function remove(d: DomainView): Promise<void> {
  busyId.value = d.id
  try {
    await apiFetch('/api/user/custom-domains/:domainId', { method: 'delete', path: { domainId: d.id } })
    await load()
  } catch (e) {
    showContextualError(e, 'customDomains.removeFailed')
  } finally {
    busyId.value = null
  }
}

function statusColor(d: DomainView): 'success' | 'neutral' | 'error' {
  if (d.status === 'verified') return 'success'
  return d.status === 'failed' ? 'error' : 'neutral'
}
function checkedAt(d: DomainView): string {
  return d.lastCheckedAt ? new Date(d.lastCheckedAt).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}
const canAdd = computed(() => data.value?.available === true && data.value.domains.length < data.value.limit)
</script>

<template>
  <div class="min-h-[100dvh] bg-muted text-default relative">
    <CommonHomeLink />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      :aria-label="t('pricing.close')"
      @click="onClose"
    />

    <main
      class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12"
      data-testid="custom-domain-settings"
    >
      <header class="mb-8">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /settings/domains
        </p>
        <h1 class="font-serif text-2xl sm:text-4xl font-normal tracking-tight mb-3">
          {{ t('customDomains.title') }}
        </h1>
        <p class="text-sm text-muted">
          {{ t('customDomains.intro') }}
        </p>
      </header>

      <p
        v-if="!domainsOnInstance"
        class="text-sm text-muted"
        data-testid="custom-domains-off"
      >
        {{ t('customDomains.notOnInstance') }}
      </p>

      <div
        v-else-if="data"
        class="space-y-6"
      >
        <CommonPlanLimitNotice
          v-if="!data.available"
          message-key="plan.feature.customDomains"
        />

        <form
          v-if="data.available"
          class="flex gap-2"
          data-testid="custom-domain-add"
          @submit.prevent="add"
        >
          <UInput
            v-model="hostname"
            :placeholder="t('customDomains.placeholder')"
            class="flex-1 font-mono"
            :disabled="adding || !canAdd"
            data-testid="custom-domain-hostname"
          />
          <UButton
            type="submit"
            color="neutral"
            :loading="adding"
            :disabled="!canAdd || !hostname.trim()"
            data-testid="custom-domain-add-submit"
          >
            {{ t('customDomains.add') }}
          </UButton>
        </form>

        <p
          v-if="data.domains.length === 0"
          class="text-sm text-muted"
        >
          {{ t('customDomains.empty') }}
        </p>

        <section
          v-for="d in data.domains"
          :key="d.id"
          class="bg-default rounded-md p-4 sm:p-5 space-y-4"
          :data-testid="`custom-domain-${d.hostname}`"
        >
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="font-serif text-lg font-normal tracking-tight flex-1 break-all">
              {{ d.hostname }}
            </h2>
            <UBadge
              :color="statusColor(d)"
              variant="subtle"
              :data-testid="`custom-domain-status-${d.hostname}`"
            >
              {{ t(`customDomains.status.${d.status}`) }}
            </UBadge>
          </div>

          <p
            v-if="d.problem && d.status !== 'verified'"
            class="text-sm text-muted"
          >
            {{ t(`customDomains.problem.${d.problem}`) }}
          </p>
          <p
            v-else-if="d.problem && d.status === 'verified'"
            class="text-sm text-muted"
          >
            {{ t('customDomains.problemWhileLive') }}
          </p>

          <div
            v-if="d.status !== 'verified'"
            class="space-y-2"
          >
            <p class="text-sm">
              {{ t('customDomains.dnsIntro') }}
            </p>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs font-mono">
                <thead class="text-muted">
                  <tr>
                    <th class="py-1 pr-3 font-normal">
                      {{ t('customDomains.dns.type') }}
                    </th>
                    <th class="py-1 pr-3 font-normal">
                      {{ t('customDomains.dns.name') }}
                    </th>
                    <th class="py-1 font-normal">
                      {{ t('customDomains.dns.value') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="py-1 pr-3">
                      TXT
                    </td>
                    <td class="py-1 pr-3 break-all">
                      {{ d.dns.txtName }}
                    </td>
                    <td class="py-1 break-all">
                      <button
                        type="button"
                        class="underline decoration-dotted"
                        :data-testid="`custom-domain-txt-${d.hostname}`"
                        @click="copy(d.dns.txtValue)"
                      >
                        {{ d.dns.txtValue }}
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td class="py-1 pr-3">
                      CNAME
                    </td>
                    <td class="py-1 pr-3 break-all">
                      {{ d.hostname }}
                    </td>
                    <td class="py-1 break-all">
                      {{ d.dns.cnameTarget }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="text-xs text-muted">
              {{ t('customDomains.apexHelp', { target: d.dns.cnameTarget }) }}
            </p>
          </div>

          <p
            v-if="d.status === 'verified'"
            class="text-sm"
            :data-testid="`custom-domain-page-${d.hostname}`"
          >
            <template v-if="d.page">
              {{ t('customDomains.shows') }}
              <NuxtLink
                :to="`/d/${d.page.docId}`"
                class="underline"
              >{{ d.page.title || t('customDomains.untitled') }}</NuxtLink>
              · <a
                :href="d.url"
                target="_blank"
                rel="noopener"
                class="underline font-mono"
              >{{ d.url }}</a>
            </template>
            <template v-else>
              {{ t('customDomains.noPage') }}
            </template>
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="busyId === d.id"
              :data-testid="`custom-domain-check-${d.hostname}`"
              @click="check(d)"
            >
              {{ t('customDomains.check') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="busyId === d.id"
              :data-testid="`custom-domain-remove-${d.hostname}`"
              @click="remove(d)"
            >
              {{ t('customDomains.remove') }}
            </UButton>
            <span
              v-if="d.lastCheckedAt"
              class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
            >
              {{ t('customDomains.lastChecked', { date: checkedAt(d) }) }}
            </span>
          </div>
        </section>
      </div>

      <div
        v-else-if="loading"
        class="text-sm text-muted"
      >
        {{ t('customDomains.loading') }}
      </div>
    </main>
  </div>
</template>
