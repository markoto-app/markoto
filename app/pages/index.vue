<script setup lang="ts">
const { t } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()
const creating = ref(false)

async function createDocument() {
  creating.value = true
  try {
    const { docId } = await $fetch<{ docId: string }>('/api/docs', { method: 'POST' })
    router.push(`/d/${docId}`)
  } catch {
    // Fallback: generate client-side ID
    const id = Math.random().toString(36).substring(2, 12)
    router.push(`/d/${id}`)
  } finally {
    creating.value = false
  }
}

// Fetch user's documents if logged in
const myDocs = ref<any[]>([])
const loadingDocs = ref(false)

watch(loggedIn, async (val) => {
  if (val) {
    loadingDocs.value = true
    try {
      myDocs.value = await $fetch<any[]>('/api/user/documents')
    } catch {
      // Not logged in or error
    } finally {
      loadingDocs.value = false
    }
  } else {
    myDocs.value = []
  }
}, { immediate: true })

function formatDate(value: string | number | Date) {
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="border-b border-default px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-file-text" class="text-primary size-6" />
        <span class="text-lg font-semibold">{{ t('app.name') }}</span>
      </div>
      <div class="flex items-center gap-2">
        <AuthUserMenu />
        <UColorModeButton />
      </div>
    </header>

    <!-- Hero -->
    <main class="flex-1 flex flex-col items-center px-6 py-12">
      <div class="max-w-2xl text-center space-y-6">
        <h1 class="text-4xl md:text-5xl font-bold tracking-tight">
          {{ t('landing.hero') }}
        </h1>
        <p class="text-lg text-muted">
          {{ t('landing.subtitle') }}
        </p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <UButton
            size="xl"
            icon="i-lucide-plus"
            :loading="creating"
            @click="createDocument"
          >
            {{ t('landing.newDocument') }}
          </UButton>
        </div>
      </div>

      <!-- Recent documents -->
      <div v-if="loggedIn && myDocs.length > 0" class="mt-12 w-full max-w-2xl">
        <h2 class="text-lg font-semibold mb-4">{{ t('landing.recentDocuments') }}</h2>
        <div class="space-y-2">
          <NuxtLink
            v-for="doc in myDocs"
            :key="doc.docId"
            :to="`/d/${doc.docId}`"
            class="flex items-center justify-between p-3 rounded-lg border border-default hover:bg-muted/50 transition-colors"
          >
            <div class="flex items-center gap-3 min-w-0">
              <UIcon name="i-lucide-file-text" class="size-5 text-muted shrink-0" />
              <div class="min-w-0">
                <p class="text-sm font-medium truncate">{{ doc.title }}</p>
                <p class="text-xs text-muted">{{ formatDate(doc.lastActive) }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <UBadge v-if="doc.accessMode !== 'open-edit'" size="xs" color="neutral" variant="subtle">
                {{ doc.accessMode === 'open-view' ? 'View only' : 'Protected' }}
              </UBadge>
              <span class="text-xs text-muted">{{ doc.wordCount || 0 }} words</span>
            </div>
          </NuxtLink>
        </div>
      </div>

      <div v-else-if="loggedIn && loadingDocs" class="mt-12">
        <UIcon name="i-lucide-loader" class="size-6 animate-spin text-muted" />
      </div>

      <!-- Features -->
      <div class="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl w-full">
        <div class="text-center space-y-2">
          <UIcon name="i-lucide-users" class="text-primary size-8 mx-auto" />
          <h3 class="font-semibold">Real-time Collaboration</h3>
          <p class="text-sm text-muted">Edit together with live cursors and presence indicators</p>
        </div>
        <div class="text-center space-y-2">
          <UIcon name="i-lucide-sparkles" class="text-primary size-8 mx-auto" />
          <h3 class="font-semibold">AI Writing Assistant</h3>
          <p class="text-sm text-muted">Get intelligent suggestions and completions as you write</p>
        </div>
        <div class="text-center space-y-2">
          <UIcon name="i-lucide-shield-check" class="text-primary size-8 mx-auto" />
          <h3 class="font-semibold">Flexible Sharing</h3>
          <p class="text-sm text-muted">Public, view-only, or password-protected documents</p>
        </div>
      </div>
    </main>

    <!-- Footer -->
    <footer class="border-t border-default px-6 py-4 text-center text-sm text-muted">
      YPad — Collaborative Markdown Editor
    </footer>
  </div>
</template>
