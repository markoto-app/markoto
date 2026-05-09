<script setup lang="ts">
import { useQRCode } from '@vueuse/integrations/useQRCode'

const props = defineProps<{
  docId: string
  docTitle: string
  isOwner: boolean
  currentAccessMode: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  updated: [accessMode: string]
}>()

const { t } = useI18n()
const { copy, copied } = useClipboard()
// Web Share API: shows the OS share sheet on iOS/Android Safari +
// Chrome and on Edge/Chrome on Windows. `isSupported` is false on
// desktop Chrome on Linux and Firefox everywhere — we hide the button
// in that case so the user only sees what works.
const { share, isSupported: shareSupported } = useShare()
const { showContextualError } = useErrorHandler()

const accessMode = ref(props.currentAccessMode)
const password = ref('')
const saving = ref(false)
const settingPassword = ref(false)

// Keep local accessMode in sync if parent prop changes
watch(() => props.currentAccessMode, (v) => {
  accessMode.value = v
})

const accessOptions = [
  { value: 'private', label: 'share.private', icon: 'i-lucide-lock-keyhole' },
  { value: 'open-edit', label: 'share.openEdit', icon: 'i-lucide-pencil' },
  { value: 'open-view', label: 'share.openView', icon: 'i-lucide-eye' },
  { value: 'password-protected', label: 'share.passwordProtected', icon: 'i-lucide-lock' }
]

const shareUrl = computed(() => {
  if (import.meta.client) {
    return `${globalThis.location.origin}/d/${props.docId}`
  }
  return `/d/${props.docId}`
})

function copyLink() {
  copy(shareUrl.value)
}

// QR code rendering of the share URL — toggled by the user so casual
// shares (just copy a link) don't ship a 6KB image they didn't ask
// for. Generated client-side only when shown; the QR is a 160px PNG
// data-URL that scales crisply on retina without a separate hi-DPI
// asset. Mobile-handoff use case: laptop owner shows screen, person
// scans → opens the doc.
const showQrCode = ref(false)
const qrCodeDataUrl = useQRCode(shareUrl, { width: 320, margin: 1 })

async function shareLink() {
  try {
    await share({
      title: props.docTitle || t('share.title'),
      url: shareUrl.value
    })
  } catch {
    // User dismissed the sheet or browser denied — silent. The copy
    // button is still right next to it as a fallback.
  }
}

async function saveAccessMode(mode: string) {
  if (mode === 'password-protected') {
    settingPassword.value = true
    accessMode.value = mode
    return
  }

  saving.value = true
  try {
    if (props.currentAccessMode === 'password-protected' && mode !== 'password-protected') {
      await $fetch(`/api/docs/${props.docId}/password`, {
        method: 'POST',
        body: { action: 'remove' }
      })
    }

    await $fetch(`/api/docs/${props.docId}/meta`, {
      method: 'PUT',
      body: { accessMode: mode }
    })
    accessMode.value = mode
    emit('updated', mode)
  } catch (e) {
    showContextualError(e, 'error.shareAccessModeFailed')
  } finally {
    saving.value = false
  }
}

async function setPassword() {
  if (!password.value || password.value.length < 4) return

  saving.value = true
  try {
    await $fetch(`/api/docs/${props.docId}/password`, {
      method: 'POST',
      body: { action: 'set', password: password.value }
    })
    settingPassword.value = false
    password.value = ''
    emit('updated', 'password-protected')
  } catch (e) {
    showContextualError(e, 'error.sharePasswordFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('share.title')"
    :description="shareUrl"
  >
    <template #content>
      <div
        data-testid="share-modal"
        class="p-6 space-y-5"
      >
        <div>
          <h3 class="text-lg font-semibold">
            {{ t('share.title') }}
          </h3>
          <p class="text-xs text-muted mt-1">
            {{ t('share.subtitle') }}
          </p>
        </div>

        <!-- Copy link -->
        <div>
          <label
            for="share-link-input"
            class="block text-sm font-medium mb-2"
          >{{ t('share.copyLink') }}</label>
          <div class="flex gap-2">
            <UInput
              id="share-link-input"
              :model-value="shareUrl"
              readonly
              data-testid="share-link-input"
              class="flex-1"
              size="sm"
            />
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="solid"
              size="sm"
              data-testid="share-copy-link-button"
              :aria-label="copied ? t('share.linkCopied') : t('share.copyLink')"
              @click="copyLink"
            >
              {{ copied ? t('share.linkCopied') : t('share.copyLink') }}
            </UButton>
            <!-- Native OS share sheet — only shown when supported
                 (mobile Safari/Chrome, Edge). On desktop Chrome (Linux)
                 and Firefox everywhere it's hidden. -->
            <UButton
              v-if="shareSupported"
              icon="i-lucide-share"
              color="neutral"
              variant="ghost"
              size="sm"
              data-testid="share-system-button"
              :aria-label="t('share.systemShare')"
              :title="t('share.systemShare')"
              @click="shareLink"
            />
            <!-- QR toggle — collapsed by default; opens a 160px square
                 below the link row for mobile-handoff scanning. -->
            <UButton
              :icon="showQrCode ? 'i-lucide-x' : 'i-lucide-qr-code'"
              color="neutral"
              variant="ghost"
              size="sm"
              data-testid="share-qr-toggle"
              :aria-label="t('share.qrCode')"
              :aria-pressed="showQrCode"
              :title="t('share.qrCode')"
              @click="showQrCode = !showQrCode"
            />
          </div>
          <!-- QR rendering — sits beneath the link row. The data-url
               is reactive on `shareUrl`, so changing access mode (or
               anything else that mutates the URL) re-renders the QR
               automatically. -->
          <div
            v-if="showQrCode"
            class="mt-3 flex justify-center"
            data-testid="share-qr-image-wrapper"
          >
            <img
              :src="qrCodeDataUrl"
              :alt="t('share.qrCode')"
              class="rounded-md border border-default bg-white p-2"
              width="160"
              height="160"
            >
          </div>
        </div>

        <!-- Access mode (owner only) -->
        <fieldset
          v-if="isOwner"
          class="border-0 p-0 m-0"
        >
          <legend class="block text-sm font-medium mb-2">
            {{ t('share.accessMode') }}
          </legend>
          <div class="space-y-2">
            <button
              v-for="opt in accessOptions"
              :key="opt.value"
              class="w-full flex items-center gap-3 p-3 rounded-lg border transition-colors"
              :class="accessMode === opt.value
                ? 'border-primary bg-primary/5'
                : 'border-default hover:border-muted'"
              :disabled="saving"
              :data-testid="`share-access-${opt.value}`"
              @click="saveAccessMode(opt.value)"
            >
              <UIcon
                :name="opt.icon"
                class="size-5 shrink-0"
              />
              <div class="text-left">
                <div class="text-sm font-medium">
                  {{ t(opt.label) }}
                </div>
              </div>
              <UIcon
                v-if="accessMode === opt.value"
                name="i-lucide-check"
                class="size-4 ml-auto text-primary"
              />
            </button>
          </div>

          <!-- Password input -->
          <div
            v-if="settingPassword"
            class="mt-3 p-3 rounded-lg border border-default bg-[var(--ui-bg-muted)]"
          >
            <label
              for="share-password-input"
              class="block text-sm font-medium mb-2"
            >{{ t('share.setPassword') }}</label>
            <div class="flex gap-2 items-stretch">
              <UInput
                id="share-password-input"
                v-model="password"
                type="password"
                :placeholder="t('share.passwordPlaceholder')"
                size="sm"
                class="flex-1"
                :ui="{ root: 'flex-1', base: 'w-full' }"
                data-testid="share-password-input"
                @keydown.enter="setPassword"
              />
              <UButton
                size="sm"
                class="shrink-0"
                :loading="saving"
                :disabled="!password || password.length < 4"
                data-testid="share-password-save"
                @click="setPassword"
              >
                {{ t('common.save') }}
              </UButton>
            </div>
            <p class="text-xs text-muted mt-1">
              {{ t('share.passwordMinLength') }}
            </p>
          </div>
        </fieldset>

        <!-- Non-owner: just show current mode -->
        <div v-else>
          <p class="block text-sm font-medium mb-2">
            {{ t('share.accessMode') }}
          </p>
          <UBadge
            variant="subtle"
            size="md"
          >
            <UIcon
              :name="accessOptions.find(o => o.value === accessMode)?.icon || 'i-lucide-globe'"
              class="size-3.5 mr-1"
            />
            {{ t(accessOptions.find(o => o.value === accessMode)?.label || 'share.openEdit') }}
          </UBadge>
        </div>

        <!-- Close -->
        <div class="flex justify-end pt-2">
          <UButton
            variant="ghost"
            @click="open = false"
          >
            {{ t('common.close') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
