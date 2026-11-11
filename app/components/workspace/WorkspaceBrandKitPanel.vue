<script setup lang="ts">
// The workspace brand kit (WP10), admins: fonts and logos every document
// of the workspace can use (theme panel), the locked workspace design and
// the workspace templates. Server: `server/api/workspaces/[wsId]/brand/`.
import { formatBytes } from '~/utils/billing/usageMeter'
import { brandFontFaceCss } from '~~/shared/utils/theme/brandFonts'
import type { BrandFont, BrandFontFormat } from '~~/shared/config/brandKit'
import type { DocTheme } from '~~/shared/types/theme'

interface FontRow { id: string, file: string, family: string, weight: number, style: 'normal' | 'italic', format: BrandFontFormat, sizeBytes: number }
interface ImageRow { id: string, file: string, name: string, format: string, sizeBytes: number, url: string }
interface BrandKit {
  available: boolean
  canManage: boolean
  limits: { fonts: number, images: number }
  fonts: FontRow[]
  images: ImageRow[]
}

const props = defineProps<{
  workspaceId: string
  /** The workspace's documents (design source, template targets). */
  documents: Array<{ docId: string, title: string }>
  defaultTheme: DocTheme | null
  locked: boolean
}>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const kit = ref<BrandKit | null>(null)
const base = computed(() => `/api/workspaces/${encodeURIComponent(props.workspaceId)}/brand`)

async function load(): Promise<void> {
  try {
    kit.value = await $fetch<BrandKit>(base.value)
  } catch (e) {
    showError('brandKit.loadFailed', e)
  }
}
onMounted(load)

// Show each font in its own face here too (same-origin, session).
useHead(() => ({
  style: kit.value?.fonts.length
    ? [{
        key: 'brand-kit-panel-fonts',
        textContent: brandFontFaceCss(kit.value.fonts as BrandFont[], file => `${base.value}/files/${file}`)
      }]
    : []
}))

const families = computed(() => {
  const groups = new Map<string, FontRow[]>()
  for (const f of kit.value?.fonts ?? []) {
    const list = groups.get(f.family) ?? []
    list.push(f)
    groups.set(f.family, list)
  }
  return [...groups.entries()].map(([family, faces]) => ({ family, faces }))
})

// ── Font upload ────────────────────────────────────────────────────
const fontFile = ref<File | null>(null)
const fontFamily = ref('')
const fontLicence = ref(false)
const fontUploading = ref(false)

function onFontFile(e: Event) {
  const input = e.target as HTMLInputElement
  fontFile.value = input.files?.[0] ?? null
  input.value = ''
}

async function uploadFont(): Promise<void> {
  if (!fontFile.value || !fontLicence.value) return
  fontUploading.value = true
  try {
    const form = new FormData()
    form.append('file', fontFile.value)
    form.append('licence', 'true')
    if (fontFamily.value.trim()) form.append('family', fontFamily.value.trim())
    const added = await $fetch<{ family: string, weight: number, style: string }>(`${base.value}/fonts`, { method: 'POST', body: form })
    toast.add({ title: t('brandKit.fontAdded', { name: `${added.family} ${added.weight}${added.style === 'italic' ? ' italic' : ''}` }), icon: 'i-lucide-check', color: 'neutral' })
    fontFile.value = null
    await load()
    emit('changed')
  } catch (e) {
    showError('brandKit.uploadFailed', e)
  } finally {
    fontUploading.value = false
  }
}

// ── Logo upload ────────────────────────────────────────────────────
const imageUploading = ref(false)
async function onImageFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  imageUploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    await $fetch(`${base.value}/images`, { method: 'POST', body: form })
    await load()
    emit('changed')
  } catch (e) {
    showError('brandKit.uploadFailed', e)
  } finally {
    imageUploading.value = false
  }
}

const busy = ref<string | null>(null)
async function remove(id: string): Promise<void> {
  busy.value = id
  try {
    await $fetch(`${base.value}/assets/${id}`, { method: 'DELETE' })
    await load()
    emit('changed')
  } catch (e) {
    showError('brandKit.deleteFailed', e)
  } finally {
    busy.value = null
  }
}

function faceLabel(f: FontRow): string {
  return `${f.weight}${f.style === 'italic' ? ` ${t('brandKit.italic')}` : ''}`
}
</script>

<template>
  <section
    class="space-y-8"
    data-testid="workspace-brand-kit-panel"
  >
    <div class="space-y-2">
      <div class="flex items-center gap-2.5">
        <UIcon
          name="i-lucide-palette"
          class="text-toned size-5 shrink-0"
        />
        <h2 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('brandKit.title') }}
        </h2>
      </div>
      <p class="text-sm text-muted max-w-2xl">
        {{ t('brandKit.intro') }}
      </p>
      <CommonPlanLimitNotice
        v-if="kit && !kit.available"
        message-key="plan.feature.brandKit"
      />
    </div>

    <!-- Fonts -->
    <div class="space-y-3">
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
        {{ t('brandKit.fonts') }}
      </h3>
      <p class="text-sm text-muted max-w-2xl">
        {{ t('brandKit.fontsHint') }}
      </p>
      <ul
        v-if="families.length"
        class="rounded-lg border border-default bg-default divide-y divide-default"
      >
        <li
          v-for="g in families"
          :key="g.family"
          class="px-4 py-3 space-y-2"
          :data-testid="`brand-font-family-${g.family}`"
        >
          <p
            class="text-lg"
            :style="{ fontFamily: `'${g.family}', system-ui` }"
          >
            {{ g.family }}
          </p>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="f in g.faces"
              :key="f.id"
              class="inline-flex items-center gap-1.5 rounded border border-default px-2 py-1 text-sm"
              :style="{ fontFamily: `'${f.family}', system-ui`, fontWeight: f.weight, fontStyle: f.style }"
              :data-testid="`brand-font-${f.id}`"
            >
              {{ faceLabel(f) }}
              <span class="font-mono text-[10.5px] text-muted not-italic font-normal">{{ formatBytes(f.sizeBytes) }}</span>
              <UButton
                v-if="kit?.canManage"
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="t('brandKit.delete')"
                :loading="busy === f.id"
                @click="remove(f.id)"
              />
            </span>
          </div>
        </li>
      </ul>
      <p
        v-else
        class="text-sm text-muted"
      >
        {{ t('brandKit.noFonts') }}
      </p>

      <div
        v-if="kit?.canManage && kit.available"
        class="rounded-lg border border-default bg-default p-4 space-y-3 max-w-xl"
        data-testid="brand-font-upload"
      >
        <div class="flex items-center gap-2 flex-wrap">
          <label class="flex">
            <input
              type="file"
              accept=".woff2,.woff,.ttf,font/woff2,font/woff,font/ttf"
              class="hidden"
              data-testid="brand-font-file"
              @change="onFontFile"
            >
            <UButton
              as="span"
              color="neutral"
              variant="outline"
              icon="i-lucide-type"
            >
              {{ t('brandKit.chooseFont') }}
            </UButton>
          </label>
          <span
            v-if="fontFile"
            class="text-sm truncate max-w-56"
          >{{ fontFile.name }}</span>
        </div>
        <UFormField
          :label="t('brandKit.fontName')"
          :help="t('brandKit.fontNameHelp')"
        >
          <UInput
            v-model="fontFamily"
            :placeholder="t('brandKit.fontNamePlaceholder')"
            data-testid="brand-font-family"
          />
        </UFormField>
        <UCheckbox
          v-model="fontLicence"
          :label="t('brandKit.licence')"
          data-testid="brand-font-licence"
        />
        <UButton
          color="neutral"
          icon="i-lucide-upload"
          :disabled="!fontFile || !fontLicence"
          :loading="fontUploading"
          data-testid="brand-font-upload-submit"
          @click="uploadFont"
        >
          {{ t('brandKit.uploadFont') }}
        </UButton>
      </div>
    </div>

    <!-- Logos -->
    <div class="space-y-3">
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
        {{ t('brandKit.logos') }}
      </h3>
      <p class="text-sm text-muted max-w-2xl">
        {{ t('brandKit.logosHint') }}
      </p>
      <div class="flex flex-wrap gap-3">
        <div
          v-for="img in kit?.images ?? []"
          :key="img.id"
          class="rounded-lg border border-default bg-default p-3 flex flex-col items-center gap-2 w-40"
          :data-testid="`brand-image-${img.id}`"
        >
          <img
            :src="`${base}/files/${img.file}`"
            :alt="img.name"
            class="h-12 max-w-full object-contain"
          >
          <span class="text-xs text-muted truncate max-w-full">{{ img.name }}</span>
          <UButton
            v-if="kit?.canManage"
            icon="i-lucide-trash-2"
            color="neutral"
            variant="ghost"
            size="xs"
            :loading="busy === img.id"
            :aria-label="t('brandKit.delete')"
            @click="remove(img.id)"
          />
        </div>
        <label
          v-if="kit?.canManage && kit.available"
          class="rounded-lg border border-dashed border-default p-3 flex flex-col items-center justify-center gap-2 w-40 cursor-pointer"
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="hidden"
            data-testid="brand-image-file"
            @change="onImageFile"
          >
          <UIcon
            :name="imageUploading ? 'i-lucide-loader' : 'i-lucide-image-plus'"
            :class="['size-6 text-muted', imageUploading && 'animate-spin']"
          />
          <span class="text-xs text-muted">{{ t('brandKit.uploadLogo') }}</span>
        </label>
      </div>
    </div>

    <!-- The workspace design + lock and the templates (admins). -->
    <WorkspaceBrandDesign
      v-if="kit?.canManage"
      :workspace-id="workspaceId"
      :documents="documents"
      :default-theme="defaultTheme"
      :locked="locked"
      :available="kit.available"
      @changed="emit('changed')"
    />
  </section>
</template>
