<script setup lang="ts">
// The document title in the top bar: click to rename. Saving writes the
// live title (Y.js) and persists it to the documents row so it appears in
// document lists; the input stays until that write settles.
const props = defineProps<{
  docId: string
}>()
const title = defineModel<string>('title', { required: true })
const { t } = useI18n()

// `useFocus` handles focus only, so entering edit mode sets it and then
// selects the text on a tick.
const editingTitle = ref(false)
const titleInput = ref('')
const titleInputEl = ref<HTMLInputElement | null>(null)
const { focused: titleFocused } = useFocus(titleInputEl)

function startEditTitle() {
  titleInput.value = title.value
  editingTitle.value = true
  void nextTick(() => {
    titleFocused.value = true
    titleInputEl.value?.select()
  })
}

async function saveTitle() {
  const newTitle = titleInput.value.trim()
  if (newTitle && newTitle !== title.value) {
    title.value = newTitle
    // Persist to the DB so the title appears in document lists.
    try {
      await apiFetch('/api/docs/:docId/meta', {
        method: 'put',
        path: { docId: props.docId },
        body: { title: newTitle }
      })
    } catch {
      // Y.js still has the title; DB persistence is best-effort.
    }
  }
  editingTitle.value = false
}
</script>

<template>
  <div
    v-if="editingTitle"
    class="flex items-center gap-1"
  >
    <input
      ref="titleInputEl"
      v-model="titleInput"
      :aria-label="t('editor.titleInputAria')"
      data-testid="doc-title-input"
      class="bg-transparent border border-default rounded px-2 py-0.5 text-sm w-48 outline-none focus:border-primary"
      @keydown.enter="saveTitle"
      @keydown.escape="editingTitle = false"
      @blur="saveTitle"
    >
  </div>
  <!-- Fraunces serif at weight 400: the title reads as a published piece, not a filename. -->
  <button
    v-else
    data-testid="doc-title-button"
    class="font-serif text-[19px] font-normal tracking-tight leading-none text-default hover:text-muted transition-colors truncate min-w-0 max-w-[180px] sm:max-w-56 md:max-w-80"
    @click="startEditTitle"
  >
    {{ title }}
  </button>
</template>
