<script setup lang="ts">
// Per-tool detail view for an `ai.tool` activity row. We render
// directly from the row's `metadata` blob — no extra round-trip.
// All persistence happened at runLoop time when the tool fired, so
// the drawer just needs to switch on `metadata.tool` and pick the
// right sub-renderer.
//
// Why no API call: the data per row is small (sources array, image
// strip, prompt text — all bounded) and travels with the activity
// list response anyway. Saving the round-trip here keeps the
// expansion instant.

interface Source { title: string, uri: string }
interface FetchImage { url: string, description?: string }

interface AiToolMetadata {
  kind: 'ai.tool'
  tool: 'web_search' | 'fetch_url' | 'generate_image' | 'view_image' | 'search_knowledge' | 'get_knowledge_file'
  query?: string
  url?: string
  prompt?: string
  src?: string
  knowledgeId?: string
  sources?: Source[]
  summary?: string
  images?: FetchImage[]
}

const props = defineProps<{
  metadata: AiToolMetadata
}>()

const { t } = useI18n()

// Try to surface a host-only URL on link rows so the narrow sidebar
// doesn't blow out on long URIs. Falls back to the raw URL on parse
// failure (which would only happen for malformed inputs).
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
    <!-- web_search: synthesized query + clickable source list -->
    <template v-if="metadata.tool === 'web_search'">
      <div
        v-if="metadata.query"
        class="text-xs text-default italic break-words"
      >
        “{{ metadata.query }}”
      </div>
      <div
        v-if="metadata.sources && metadata.sources.length > 0"
        class="space-y-1"
      >
        <div class="text-[11px] uppercase tracking-wide text-muted">
          {{ t('activity.aiTool.sourcesHeading') }}
        </div>
        <ul class="space-y-1">
          <li
            v-for="(src, i) in metadata.sources"
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

    <!-- fetch_url: page summary + image strip -->
    <template v-else-if="metadata.tool === 'fetch_url'">
      <a
        v-if="metadata.url"
        :href="metadata.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs text-primary hover:underline flex items-center gap-1.5 break-all"
      >
        <UIcon
          name="i-lucide-external-link"
          class="size-3 shrink-0"
        />
        {{ metadata.url }}
      </a>
      <div
        v-if="metadata.summary"
        class="text-xs text-default whitespace-pre-wrap break-words"
      >
        {{ metadata.summary }}
      </div>
      <div
        v-if="metadata.images && metadata.images.length > 0"
        class="grid grid-cols-3 gap-1"
      >
        <a
          v-for="(img, i) in metadata.images"
          :key="i"
          :href="img.url"
          target="_blank"
          rel="noopener noreferrer"
          :title="img.description ?? img.url"
          class="block rounded overflow-hidden border border-default/60 aspect-square bg-muted"
        >
          <!-- Inline thumbnail. `referrerpolicy=no-referrer` so cross-
               origin hosts don't 403 us on referer-based hotlink
               protection. `loading=lazy` because most expansions
               only show 0-1 images visible at a time. -->
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

    <!-- generate_image: prompt -->
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

    <!-- view_image: thumbnail of the image AI looked at -->
    <template v-else-if="metadata.tool === 'view_image'">
      <a
        v-if="metadata.src"
        :href="metadata.src"
        target="_blank"
        rel="noopener noreferrer"
        class="block rounded overflow-hidden border border-default/60 max-h-48 bg-muted"
      >
        <img
          :src="metadata.src"
          alt=""
          class="w-full h-full object-contain"
          loading="lazy"
          referrerpolicy="no-referrer"
        >
      </a>
    </template>

    <!-- search_knowledge: just the query for now (results expansion
         can land in a follow-up; the knowledge-base feature is
         workspace-only and we want to validate the broad UX first). -->
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

    <!-- get_knowledge_file: just the id; future-work resolves to filename -->
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
  </div>
</template>
