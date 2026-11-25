<script setup lang="ts">
import { firstDocumentBody, rememberBrowserCreatedDoc } from '~/utils/documents/firstDocument'

// "Start writing" for a first-time anonymous visitor: creates the Demo
// document straight away instead of opening the new-document dialog (the
// terms + bot check still run, `useAnonDocCreate`). Renders nothing; it is
// mounted on the first click (useStartWriting), so marketing pages don't
// ship the anonymous-gate code. Every change of `run` starts one creation.
const props = defineProps<{ run: number }>()
const emit = defineEmits<{
  created: [docId: string]
  /** The visitor backed out of the terms step, or the request failed (already reported). */
  done: []
}>()

const { locale } = useI18n()
const { showError } = useErrorHandler()
const anonDoc = useAnonDocCreate()

async function create(): Promise<void> {
  try {
    const docId = await anonDoc.createDocument(firstDocumentBody(String(locale.value)))
    rememberBrowserCreatedDoc()
    emit('created', docId)
  } catch (e) {
    if (!(e instanceof AnonGateCancelled)) showError('error.documentCreateFailed', e)
  } finally {
    emit('done')
  }
}

watch(() => props.run, () => {
  void create()
}, { immediate: true })
</script>

<template>
  <span
    hidden
    data-testid="quick-start-document"
  />
</template>
