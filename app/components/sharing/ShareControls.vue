<script setup lang="ts">
import type { ApiRequest, ApiResponse } from '~/utils/api/client'
// Share-link controls: when the public link stops working, whether
// visitors may download / print, and how often the link was opened in the
// last 30 days. Owner and workspace admins; the plan feature
// `shareControls` is needed to SET a restriction (clearing always works).
// Server: `server/api/docs/[docId]/share-settings/`.

type Settings = ApiResponse<'/api/docs/:docId/share-settings', 'get'>
type SettingsPatch = NonNullable<ApiRequest<'/api/docs/:docId/share-settings', 'put'>['body']>

const props = defineProps<{ docId: string }>()
const { t, locale } = useI18n()
const { showError } = useErrorHandler()

const settings = ref<Settings | null>(null)
const busy = ref(false)

async function load(): Promise<void> {
  try {
    settings.value = await apiFetch('/api/docs/:docId/share-settings', { path: { docId: props.docId } })
  } catch {
    settings.value = null
  }
}
onMounted(load)

// <input type="datetime-local"> speaks local wall-clock time without a zone.
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const expiryInput = ref('')
watch(settings, (s) => {
  expiryInput.value = toLocalInput(s?.expiresAt ?? null)
})

async function save(patch: SettingsPatch): Promise<void> {
  busy.value = true
  try {
    const res = await apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId: props.docId }, body: patch })
    if (settings.value) settings.value = { ...settings.value, ...res }
  } catch (e) {
    showError('share.controls.saveFailed', e)
    expiryInput.value = toLocalInput(settings.value?.expiresAt ?? null)
  } finally {
    busy.value = false
  }
}

function onExpiryChange(): void {
  const value = expiryInput.value
  void save({ expiresAt: value ? new Date(value).toISOString() : null })
}

const lastViewed = computed(() => {
  const day = settings.value?.views?.lastDay
  return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }) : null
})
const canSet = computed(() => settings.value?.available === true)
</script>

<template>
  <div
    v-if="settings"
    class="space-y-3"
    data-testid="share-controls"
  >
    <p class="block text-sm font-medium">
      {{ t('share.controls.title') }}
    </p>
    <CommonPlanLimitNotice
      v-if="!canSet"
      message-key="plan.feature.shareControls"
    />
    <UFormField
      :label="t('share.controls.expires')"
      :help="t('share.controls.expiresHelp')"
    >
      <div class="flex gap-2">
        <UInput
          v-model="expiryInput"
          type="datetime-local"
          class="flex-1"
          :disabled="busy || (!canSet && !settings.expiresAt)"
          data-testid="share-expiry"
          @change="onExpiryChange"
        />
        <UButton
          v-if="settings.expiresAt"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :aria-label="t('share.controls.clearExpiry')"
          :disabled="busy"
          data-testid="share-expiry-clear"
          @click="save({ expiresAt: null })"
        />
      </div>
    </UFormField>
    <USwitch
      :model-value="settings.noDownload"
      :disabled="busy || (!canSet && !settings.noDownload)"
      :label="t('share.controls.noDownload')"
      :description="t('share.controls.noDownloadHelp')"
      data-testid="share-no-download"
      @update:model-value="(v: boolean) => save({ noDownload: v })"
    />
    <p
      v-if="settings.views"
      class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
      data-testid="share-views"
    >
      {{ t('share.controls.views', { n: settings.views.total }, settings.views.total) }}
      <template v-if="lastViewed">
        · {{ t('share.controls.lastViewed', { date: lastViewed }) }}
      </template>
    </p>
  </div>
</template>
