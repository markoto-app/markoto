<script setup lang="ts">
// Brand kit, admins: the workspace design, taken from one of the
// workspace's documents, locked for every document, and the workspace
// templates (live links to workspace documents). Rendered inside
// WorkspaceBrandKitPanel. Server: `…/brand/lock`, `…/brand/design-from-doc`,
// `…/templates`.
import type { DocTheme } from '~~/shared/types/theme'
import type { ApiResponse } from '~/utils/api/client'

interface DocOption { docId: string, title: string }
type Template = ApiResponse<'/api/workspaces/:wsId/templates', 'get'>['templates'][number]

const props = defineProps<{
  workspaceId: string
  documents: DocOption[]
  defaultTheme: DocTheme | null
  locked: boolean
  available: boolean
}>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const docItems = computed(() => props.documents.map(d => ({ label: d.title || t('editor.untitled'), value: d.docId })))

const designDoc = ref<string | undefined>(undefined)
const designBusy = ref(false)
async function useDesignFrom(): Promise<void> {
  if (!designDoc.value) return
  designBusy.value = true
  try {
    const res = await apiFetch('/api/workspaces/:wsId/brand/design-from-doc', { method: 'post', path: { wsId: props.workspaceId }, body: { docId: designDoc.value } })
    toast.add({
      title: t('brandKit.designSet'),
      description: res.dropped.length ? t('brandKit.designImagesDropped') : undefined,
      icon: 'i-lucide-check',
      color: 'neutral'
    })
    designDoc.value = undefined
    emit('changed')
  } catch (e) {
    showError('brandKit.designFailed', e)
  } finally {
    designBusy.value = false
  }
}

const lockBusy = ref(false)
async function setLocked(locked: boolean): Promise<void> {
  lockBusy.value = true
  try {
    await apiFetch('/api/workspaces/:wsId/brand/lock', { method: 'put', path: { wsId: props.workspaceId }, body: { locked } })
    emit('changed')
  } catch (e) {
    showError('brandKit.lockFailed', e)
  } finally {
    lockBusy.value = false
  }
}

const templates = ref<Template[]>([])
async function loadTemplates(): Promise<void> {
  try {
    templates.value = (await apiFetch('/api/workspaces/:wsId/templates', { path: { wsId: props.workspaceId } })).templates
  } catch {
    templates.value = []
  }
}
onMounted(loadTemplates)

const tplDoc = ref<string | undefined>(undefined)
const tplName = ref('')
const tplDescription = ref('')
const tplBusy = ref(false)
watch(tplDoc, (id) => {
  if (id && !tplName.value) tplName.value = props.documents.find(d => d.docId === id)?.title ?? ''
})
async function addTemplate(): Promise<void> {
  if (!tplDoc.value || !tplName.value.trim()) return
  tplBusy.value = true
  try {
    await apiFetch('/api/workspaces/:wsId/templates', { method: 'post', path: { wsId: props.workspaceId }, body: { docId: tplDoc.value, name: tplName.value, description: tplDescription.value } })
    tplDoc.value = undefined
    tplName.value = ''
    tplDescription.value = ''
    await loadTemplates()
    emit('changed')
  } catch (e) {
    showError('brandKit.templateFailed', e)
  } finally {
    tplBusy.value = false
  }
}
const removing = ref<string | null>(null)
async function removeTemplate(id: string): Promise<void> {
  removing.value = id
  try {
    await apiFetch('/api/workspaces/:wsId/templates/:templateId', { method: 'delete', path: { wsId: props.workspaceId, templateId: id } })
    await loadTemplates()
    emit('changed')
  } catch (e) {
    showError('brandKit.templateFailed', e)
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <div class="space-y-8">
    <div
      class="space-y-3"
      data-testid="brand-design"
    >
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
        {{ t('brandKit.design') }}
      </h3>
      <p class="text-sm text-muted max-w-2xl">
        {{ t('brandKit.designHint') }}
      </p>
      <div class="rounded-lg border border-default bg-default p-4 space-y-4 max-w-xl">
        <div
          v-if="defaultTheme"
          class="flex items-center gap-3"
          data-testid="brand-design-current"
        >
          <span
            class="size-6 rounded-full shrink-0"
            :style="{ backgroundColor: defaultTheme.color.brand }"
          />
          <span
            class="text-lg truncate"
            :style="{ fontFamily: `'${defaultTheme.headings.font}', system-ui` }"
          >{{ defaultTheme.headings.font }} · {{ defaultTheme.body.font }}</span>
        </div>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('brandKit.noDesign') }}
        </p>
        <div
          v-if="available"
          class="flex gap-2 flex-wrap"
        >
          <USelect
            v-model="designDoc"
            :items="docItems"
            :placeholder="t('brandKit.pickDocument')"
            class="flex-1 min-w-48"
            data-testid="brand-design-doc"
          />
          <UButton
            color="neutral"
            variant="outline"
            :disabled="!designDoc"
            :loading="designBusy"
            data-testid="brand-design-use"
            @click="useDesignFrom"
          >
            {{ t('brandKit.useDesign') }}
          </UButton>
        </div>
        <USwitch
          :model-value="locked"
          :disabled="lockBusy || (!locked && (!available || !defaultTheme))"
          :label="t('brandKit.lockLabel')"
          :description="t('brandKit.lockDescription')"
          data-testid="brand-lock"
          @update:model-value="(v: boolean) => setLocked(v)"
        />
      </div>
    </div>

    <div
      class="space-y-3"
      data-testid="brand-templates"
    >
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
        {{ t('brandKit.templates') }}
      </h3>
      <p class="text-sm text-muted max-w-2xl">
        {{ t('brandKit.templatesHint') }}
      </p>
      <ul
        v-if="templates.length"
        class="rounded-lg border border-default bg-default divide-y divide-default max-w-xl"
      >
        <li
          v-for="tpl in templates"
          :key="tpl.id"
          class="px-4 py-3 flex items-center gap-3"
          :data-testid="`brand-template-${tpl.id}`"
        >
          <div class="min-w-0 flex-1">
            <p class="font-serif text-base truncate">
              {{ tpl.name }}
            </p>
            <p class="text-xs text-muted truncate">
              <NuxtLink
                :to="`/d/${tpl.docId}`"
                class="underline"
              >{{ tpl.docTitle }}</NuxtLink>
              <template v-if="tpl.description">
                · {{ tpl.description }}
              </template>
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('brandKit.removeTemplate')"
            :loading="removing === tpl.id"
            @click="removeTemplate(tpl.id)"
          />
        </li>
      </ul>
      <div
        v-if="available"
        class="rounded-lg border border-default bg-default p-4 space-y-3 max-w-xl"
        data-testid="brand-template-add"
      >
        <USelect
          v-model="tplDoc"
          :items="docItems"
          :placeholder="t('brandKit.pickDocument')"
          class="w-full"
          data-testid="brand-template-doc"
        />
        <UInput
          v-model="tplName"
          :placeholder="t('brandKit.templateName')"
          maxlength="80"
          class="w-full"
          data-testid="brand-template-name"
        />
        <UInput
          v-model="tplDescription"
          :placeholder="t('brandKit.templateDescription')"
          maxlength="200"
          class="w-full"
        />
        <UButton
          color="neutral"
          icon="i-lucide-plus"
          :disabled="!tplDoc || !tplName.trim()"
          :loading="tplBusy"
          data-testid="brand-template-submit"
          @click="addTemplate"
        >
          {{ t('brandKit.addTemplate') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
