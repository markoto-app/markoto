<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'

// Left group of the editor's top bar: where you are (brand lockup, the
// managed instance's logo), what this is (the title, the workspace plan)
// and who is here (presence, connection).
defineProps<{
  docId: string
  /** Team / Business plan of the doc's workspace: which plan its features and AI follow. */
  workspacePlan: 'team' | 'business' | null
  awareness: Awareness
  status: string
  userCount: number
}>()
const title = defineModel<string>('title', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="flex-1 min-w-0 flex items-center gap-3">
    <!-- Brand lockup (wordmark + seal), the same anchor as dashboard and
         workspace pages: always the leftmost item. -->
    <NuxtLink
      to="/"
      class="flex items-center shrink-0"
      :aria-label="t('common.homeLinkLabel')"
    >
      <CommonWordmark :size="18" />
    </NuxtLink>
    <!-- Managed instance: the customer's logo; the name only on wide screens (the title needs the room). -->
    <CommonInstanceBrand
      class="hidden md:inline-flex"
      :size="18"
      :show-name="false"
    />
    <USeparator
      orientation="vertical"
      class="h-5"
    />

    <EditorLayoutTitleField
      v-model:title="title"
      :doc-id="docId"
    />
    <!-- Team / Business plan of the doc's workspace: which plan this document's features and AI follow. -->
    <UBadge
      v-if="workspacePlan"
      size="xs"
      color="neutral"
      variant="outline"
      class="hidden sm:inline-flex shrink-0"
      data-testid="doc-plan-badge"
    >
      {{ workspacePlan === 'team' ? 'Team' : 'Business' }}
    </UBadge>

    <CollabPresenceBar
      :awareness="awareness"
      :doc-id="docId"
    />

    <EditorLayoutConnectionStatus
      :status="status"
      :user-count="userCount"
    />
  </div>
</template>
