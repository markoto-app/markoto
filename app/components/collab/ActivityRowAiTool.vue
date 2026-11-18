<script setup lang="ts">
// Per-tool detail view for an `ai.tool` activity row, rendered straight from
// the row's `metadata` (small, bounded, and already in the list response, so
// no extra request).

import { safeLinkUrl } from '~/utils/collab/activityFeedHelpers'
import type { ActivityMetadataAiTool } from '~/utils/api/types/activity'

interface Source { title: string, uri: string }
interface FetchImage { url: string, description?: string }

const props = defineProps<{
  metadata: ActivityMetadataAiTool
}>()

// Every URL below comes from a tool input or a fetched page, so it is
// bound only after `safeLinkUrl` (http(s) or a relative path); entries
// without a usable URL are not rendered as links/images.
const sources = computed(() => (props.metadata.tool === 'web_search' ? props.metadata.sources ?? [] : [])
  .map(src => ({ title: src.title, uri: safeLinkUrl(src.uri) }))
  .filter((src): src is Source => src.uri !== undefined))
const pageUrl = computed(() => safeLinkUrl(props.metadata.tool === 'fetch_url' ? props.metadata.url : undefined))
const images = computed(() => (props.metadata.tool === 'fetch_url' ? props.metadata.images ?? [] : [])
  .flatMap((img): FetchImage[] => {
    const url = safeLinkUrl(img.url)
    return url === undefined ? [] : [{ description: img.description, url }]
  }))
const viewedSrc = computed(() => safeLinkUrl(props.metadata.tool === 'view_image' ? props.metadata.src : undefined))

const { t } = useI18n()

// Host-only URL keeps the narrow sidebar from overflowing; falls back to the raw URL if parsing fails.
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return rawUrl
  }
}
</script>

<template>
  <div class="activity-row-ai-tool space-y-2">
    <template v-if="metadata.tool === 'web_search'">
      <div
        v-if="metadata.query"
        class="text-xs text-default italic break-words"
      >
        “{{ metadata.query }}”
      </div>
      <div
        v-if="sources.length > 0"
        class="space-y-1"
      >
        <div class="text-[11px] uppercase tracking-wide text-muted">
          {{ t('activity.aiTool.sourcesHeading') }}
        </div>
        <ul class="space-y-1">
          <li
            v-for="(src, i) in sources"
            :key="i"
            class="text-xs"
          >
            <a
              :href="src.uri"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary hover:underline flex items-start gap-1.5"
            >
              <UIcon
                name="i-lucide-external-link"
                class="size-3 mt-0.5 shrink-0"
              />
              <span class="flex-1 min-w-0">
                <span class="block font-medium truncate">{{ src.title }}</span>
                <span class="block text-[11px] text-muted truncate">{{ hostOf(src.uri) }}</span>
              </span>
            </a>
          </li>
        </ul>
      </div>
      <div
        v-else
        class="text-[11px] text-muted italic"
      >
        {{ t('activity.aiTool.noSources') }}
      </div>
    </template>

    <template v-else-if="metadata.tool === 'fetch_url'">
      <a
        v-if="pageUrl"
        :href="pageUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs text-primary hover:underline flex items-center gap-1.5 break-all"
      >
        <UIcon
          name="i-lucide-external-link"
          class="size-3 shrink-0"
        />
        {{ pageUrl }}
      </a>
      <div
        v-if="metadata.summary"
        class="text-xs text-default whitespace-pre-wrap break-words"
      >
        {{ metadata.summary }}
      </div>
      <div
        v-if="images.length > 0"
        class="grid grid-cols-3 gap-1"
      >
        <a
          v-for="(img, i) in images"
          :key="i"
          :href="img.url"
          target="_blank"
          rel="noopener noreferrer"
          :title="img.description ?? img.url"
          class="block rounded overflow-hidden border border-default/60 aspect-square bg-muted"
        >
          <!-- `no-referrer` avoids referer-based hotlink 403s from cross-origin hosts. -->
          <img
            :src="img.url"
            :alt="img.description ?? ''"
            class="w-full h-full object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
        </a>
      </div>
    </template>

    <template v-else-if="metadata.tool === 'generate_image'">
      <div
        v-if="metadata.prompt"
        class="text-xs text-default italic break-words"
      >
        “{{ metadata.prompt }}”
      </div>
      <div class="text-[11px] text-muted italic">
        {{ t('activity.aiTool.imageInDoc') }}
      </div>
    </template>

    <template v-else-if="metadata.tool === 'view_image'">
      <a
        v-if="viewedSrc"
        :href="viewedSrc"
        :aria-label="t('activity.aiTool.openViewedImage')"
        target="_blank"
        rel="noopener noreferrer"
        class="block rounded overflow-hidden border border-default/60 max-h-48 bg-muted"
      >
        <img
          :src="viewedSrc"
          alt=""
          class="w-full h-full object-contain"
          loading="lazy"
          referrerpolicy="no-referrer"
        >
      </a>
    </template>

    <!-- Only the query is shown; no result expansion. -->
    <template v-else-if="metadata.tool === 'search_knowledge'">
      <div
        v-if="metadata.query"
        class="text-xs text-default italic break-words"
      >
        “{{ metadata.query }}”
      </div>
      <div class="text-[11px] text-muted italic">
        {{ t('activity.aiTool.knowledgeNote') }}
      </div>
    </template>

    <template v-else-if="metadata.tool === 'get_knowledge_file'">
      <div
        v-if="metadata.knowledgeId"
        class="text-xs font-mono text-muted break-all"
      >
        {{ metadata.knowledgeId }}
      </div>
      <div class="text-[11px] text-muted italic">
        {{ t('activity.aiTool.knowledgeNote') }}
      </div>
    </template>

    <template v-else-if="metadata.tool === 'replace_all'">
      <div class="text-xs text-default break-words">
        {{ t('activity.detail.replacedAll', { count: metadata.count, from: metadata.query, to: metadata.replacement }) }}
      </div>
    </template>
  </div>
</template>
