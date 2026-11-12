# Workspace knowledge base

Members of a workspace can upload files (PDF, DOCX, PPTX, XLSX, HTML, EPUB, Markdown, text) that the AI can search while it works on the workspace's documents. Files are converted to Markdown, cut into chunks, embedded, and stored in PostgreSQL with pgvector. The UI is `app/components/workspace/WorkspaceKnowledgePanel.vue`, shown on the workspace page and in the editor's right sidebar.

## Data

- `workspace_knowledge`: one row per file. Status `processing` → `ready` or `failed`. `markdown_cache` holds the converted text (served to the `get_knowledge_file` AI tool); `embedding_version` records which model and dimension produced the vectors; `s3_key` names the uploaded original, which is deleted after successful processing.
- `workspace_knowledge_chunks`: one row per chunk: `content`, `embedding vector(768)` with an HNSW cosine index, a stored generated `content_tsv` with a GIN index, and a copy of `workspace_id` so search needs no join.

## Upload

The upload uses the same staging-key pattern as image uploads, so a re-used presigned URL can never overwrite a confirmed file.

1. `POST /api/workspaces/:wsId/knowledge/upload-request`: admin or editor (`requireKnowledgeEditAccess`), 30 requests per user per minute, plan caps checked, and in-flight slots reserved in Valkey per workspace, per user and per member (one member may hold at most half of the workspace's free slots, `memberShareOfWorkspaceSlots` in `server/utils/knowledge/knowledgeQuota.ts`). Returns a 120-second presigned PUT for the staging key `workspaces/{wsId}/knowledge/staging/{id}.{ext}` with `content-type` signed. A pending record in Valkey binds the upload to the caller (`server/utils/knowledge/knowledgePendingUpload.ts`).
2. The browser PUTs the file to S3.
3. `POST /api/workspaces/:wsId/knowledge/confirm`: claims the pending record atomically (Valkey `GETDEL`; unknown uploads get 404 before any S3 call), checks that the stored type equals the signed one (415 `knowledge/content-type-mismatch`), copies the object to its final key, deletes the staging key, and sniffs the first bytes of the copy (`server/utils/storage/fileTypeGuard.ts`). It then takes `pg_advisory_xact_lock(hashtext(wsId))`, re-checks the caps and inserts the row in one transaction, releases the in-flight slots, and starts processing without waiting.

Content sniffing: binary formats are checked by magic bytes with `file-type` on the first bytes (an S3 range request). Text formats have no magic bytes, so the guard decodes the first 1 KB as UTF-8 and requires at least 90 % printable characters. `file-type` returning nothing is not a pass.

Objects that are never confirmed are deleted by `orphan-cleanup` after an hour (`server/utils/knowledge/knowledgeOrphanSweep.ts`).

## Processing

`server/utils/knowledge/processKnowledge.ts` runs per file:

1. Read the original from S3 and send it to the markitdown service (`NUXT_MARKITDOWN_URL`).
2. Chunk the Markdown by headings and paragraphs (`server/utils/knowledge/chunkMarkdown.ts`), at most `maxChunksPerFile` (300, `shared/config/tiers.ts`) chunks; longer files are truncated with a marker chunk.
3. Embed each chunk (`server/utils/knowledge/embeddings.ts`, five requests in parallel). A vector of the wrong length is an error, never stored.
4. Replace the file's chunks, set the row to `ready` with `markdown_cache`, then delete the original from S3.

The row's existence is re-checked after conversion and after embedding, so a file deleted mid-way stops without wasted work. Errors set `failed` with a short message. The `knowledge-sweep` plugin re-processes rows stuck in `processing` for more than 10 minutes and removes old `failed` rows.

## Embeddings

All embedding calls go through LiteLLM. The hosted default is Jina `jina-embeddings-v5-text-nano` (768 dimensions). A self-hoster can point `NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings` at any OpenAI-compatible embeddings endpoint; operator documentation is in `docs/AI-MODELS.md`. Request parameters (Jina's `task` hint, `retrieval.passage` on ingest and `retrieval.query` on search; the `dimensions` field) are decided in `shared/utils/runtime/embeddingConfig.ts`.

Jina reports only `total_tokens`, which LiteLLM's built-in Jina provider prices at zero. `JinaEmbeddingsProvider` in `deploy/config/litellm/custom_handlers.py` rewrites the usage so spend is recorded.

### Column dimension and re-embedding

The schema declares `vector(768)`. At boot, `server/plugins/02-embeddings-dimension.ts` compares the column with `NUXT_LITELLM_EMBEDDINGS_DIMS` under the advisory lock `knowledge-embedding-dimension`:

- equal → nothing to do;
- different and no vectors stored → retype the column and rebuild the HNSW index;
- different and vectors stored → refuse. Knowledge features (processing and `search_knowledge`) then fail with an actionable message (`assertKnowledgeEmbeddingsReady` in `server/utils/knowledge/knowledgeEmbeddingsStatus.ts`); the rest of the app keeps working, and `/api/health/deep` reports `checks.embeddings`.

The maximum is 2000 dimensions (`MAX_EMBEDDING_DIMS`), the HNSW limit for `vector`.

`bun run knowledge:reembed` (`scripts/reembed-knowledge.ts` → `server/db/reembedKnowledge.ts`) retypes the column if needed and re-embeds every stale file from the stored chunk text, file by file, so a rerun continues where it stopped. Options: `--dry-run`, `--force`, `--batch-size`, `--concurrency`, `--pause-ms`. A model change with the same dimension is visible only in `embedding_version`; use `--force` once in that case.

## Search

`server/repos/knowledge.ts` runs two queries and fuses them:

- vector: cosine similarity over the HNSW index;
- lexical: `ts_rank_cd` on `content_tsv` with `websearch_to_tsquery('english', …)`.

Each pulls `4 × topK` candidates. Results are merged by `(knowledgeId, chunkIndex)` with Reciprocal Rank Fusion (`1 / (60 + rank)` per source, summed). A query made only of stop words gives an empty lexical result and the search falls back to vectors alone. There is no reranker.

## AI integration

The two knowledge tools (`search_knowledge`, `get_knowledge_file`) are offered only when the AI session belongs to a workspace that has at least one ready file; the system prompt then lists the files in a `<knowledge_files>` block. The tool handlers re-check the caller's workspace role on every call (`verifyWorkspaceMembership` in `server/utils/ai/tools/knowledgeTools.ts`), so a member removed mid-session loses access at the next call. See `server/utils/agentic/AGENTS.md`.

## Limits

Per-plan caps (files per user, bytes per workspace and per user) live in `shared/config/tiers.ts` and can be overridden with `TIER_*` environment variables (`server/utils/billing/tierConfig.ts`). In a Team or Business workspace with billing on, knowledge storage counts against the workspace pool (`resolveCaps` in `server/utils/knowledge/knowledgeQuota.ts`).
