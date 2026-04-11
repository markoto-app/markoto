<script setup lang="ts">
const props = defineProps<{
  source: string
}>()

const sourceRef = computed(() => props.source)
const { rendered } = useMarkdownPreview(sourceRef)
</script>

<template>
  <div class="h-full overflow-auto">
    <div
      class="preview-content prose prose-sm dark:prose-invert max-w-none p-5"
      v-html="rendered"
    />
  </div>
</template>

<style>
/* Custom container styles */
.preview-content .warning {
  border-left: 4px solid #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  padding: 1rem;
  margin: 1rem 0;
  border-radius: 0 0.25rem 0.25rem 0;
}
.preview-content .info {
  border-left: 4px solid #3b82f6;
  background: rgba(59, 130, 246, 0.08);
  padding: 1rem;
  margin: 1rem 0;
  border-radius: 0 0.25rem 0.25rem 0;
}
.preview-content .tip {
  border-left: 4px solid #22c55e;
  background: rgba(34, 197, 94, 0.08);
  padding: 1rem;
  margin: 1rem 0;
  border-radius: 0 0.25rem 0.25rem 0;
}

/* Task list styles */
.preview-content .task-list-item {
  list-style-type: none;
}
.preview-content .task-list-item input[type="checkbox"] {
  margin-right: 0.5rem;
}

/* Code block styles */
.preview-content pre {
  background: #111827;
  border-radius: 0.5rem;
  overflow-x: auto;
}
.preview-content code {
  font-size: 0.875rem;
}
</style>
