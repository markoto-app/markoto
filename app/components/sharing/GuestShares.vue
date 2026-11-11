<script setup lang="ts">
// Guests of the document's workspace this document is shared with.
// Admins and editors of the workspace pick a guest and give
// them view or edit access; a guest sees only the documents shared with
// them. Server: `server/api/docs/[docId]/shares/`.

type Access = 'view' | 'edit'
interface Share { userId: number, name: string, email: string | null, access: Access }
interface Guest { userId: number, name: string, email: string | null }

const props = defineProps<{ docId: string }>()
const { t } = useI18n()
const { showError } = useErrorHandler()

const shares = ref<Share[]>([])
const guests = ref<Guest[]>([])
const loaded = ref(false)
const busy = ref<number | null>(null)
const pick = ref<number | undefined>(undefined)
const pickAccess = ref<Access>('view')

const base = computed(() => `/api/docs/${encodeURIComponent(props.docId)}/shares`)

async function load(): Promise<void> {
  try {
    const res = await $fetch<{ shares: Share[], guests: Guest[] }>(base.value)
    shares.value = res.shares
    guests.value = res.guests
  } catch (e) {
    showError('share.guests.loadFailed', e)
  } finally {
    loaded.value = true
  }
}
onMounted(load)

const available = computed(() => guests.value
  .filter(g => !shares.value.some(s => s.userId === g.userId))
  .map(g => ({ label: g.email ? `${g.name} · ${g.email}` : g.name, value: g.userId })))

const accessItems = computed(() => [
  { label: t('share.guests.view'), value: 'view' },
  { label: t('share.guests.edit'), value: 'edit' }
])

async function setAccess(userId: number, access: Access): Promise<void> {
  busy.value = userId
  try {
    await $fetch(base.value, { method: 'PUT', body: { userId, access } })
    await load()
  } catch (e) {
    showError('share.guests.saveFailed', e)
  } finally {
    busy.value = null
  }
}

async function add(): Promise<void> {
  if (pick.value === undefined) return
  await setAccess(pick.value, pickAccess.value)
  pick.value = undefined
  pickAccess.value = 'view'
}

async function remove(userId: number): Promise<void> {
  busy.value = userId
  try {
    await $fetch(`${base.value}/${userId}`, { method: 'DELETE' })
    shares.value = shares.value.filter(s => s.userId !== userId)
  } catch (e) {
    showError('share.guests.saveFailed', e)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div
    v-if="loaded && (guests.length > 0 || shares.length > 0)"
    class="space-y-2"
    data-testid="share-guests"
  >
    <p class="block text-sm font-medium">
      {{ t('share.guests.title') }}
    </p>
    <p class="text-xs text-muted">
      {{ t('share.guests.hint') }}
    </p>
    <ul
      v-if="shares.length > 0"
      class="divide-y divide-default border border-default rounded-lg overflow-hidden"
    >
      <li
        v-for="s in shares"
        :key="s.userId"
        class="flex items-center gap-3 p-2.5"
        :data-testid="`share-guest-${s.userId}`"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm truncate">
            {{ s.name }}
          </p>
          <p
            v-if="s.email"
            class="text-xs text-muted truncate"
          >
            {{ s.email }}
          </p>
        </div>
        <USelect
          :model-value="s.access"
          :items="accessItems"
          size="xs"
          class="w-36"
          :disabled="busy === s.userId"
          :data-testid="`share-guest-access-${s.userId}`"
          @update:model-value="(v: string) => setAccess(s.userId, v as Access)"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('share.guests.remove')"
          :loading="busy === s.userId"
          :data-testid="`share-guest-remove-${s.userId}`"
          @click="remove(s.userId)"
        />
      </li>
    </ul>
    <div
      v-if="available.length > 0"
      class="flex gap-2"
    >
      <USelect
        v-model="pick"
        :items="available"
        :placeholder="t('share.guests.pick')"
        size="sm"
        class="flex-1"
        data-testid="share-guest-pick"
      />
      <USelect
        v-model="pickAccess"
        :items="accessItems"
        size="sm"
        class="w-36"
        data-testid="share-guest-pick-access"
      />
      <UButton
        size="sm"
        color="neutral"
        icon="i-lucide-plus"
        :disabled="pick === undefined"
        data-testid="share-guest-add"
        @click="add"
      >
        {{ t('share.guests.add') }}
      </UButton>
    </div>
  </div>
</template>
