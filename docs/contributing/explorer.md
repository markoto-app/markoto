# Folders, the documents explorer, search and bulk import

How documents are organised (folders), found (search), listed (paginated), changed in bulk, and brought in by the hundred (import jobs). User-facing description: `content/docs/workspaces/organize-documents.md` and `content/docs/import-export/bulk-import.md`.

## Folders

- Table `folders` (`server/db/schema/folders.ts`): an adjacency list. Exactly one of `workspace_id` (a workspace folder) or `owner_id` (a personal folder) is set; sibling names are unique case-insensitively. `documents.folder_id` points at a folder of the document's own scope (its workspace, or its owner's personal folders); moving a document to another workspace clears it.
- Folders carry no permissions. The workspace stays the access boundary: any member sees the tree, admins and editors change it, guests never see it. The repo functions take the scope proof (`WorkspaceAccess` or the owner's `UserScope`, `server/repos/folders.ts`); `server/utils/access/folderProof.ts` turns a folder id into that proof (404 for a folder the caller can't reach).
- Depth is limited to 8 levels; moves are serialised per scope (advisory lock) and refuse a cycle (`folder/cycle`).
- Deleting a folder deletes its subfolders and every document below them, each through the normal document delete (`deleteDocuments` in `server/utils/documents/documentLifecycle.ts`: rows first, then storage, renders, published pages and the sync server's `notify-deleted`, so open editors show the deleted notice). It is refused as a whole (`folder/delete-blocked`) unless the caller may delete every one of those documents.

## Lists, search and the change counter

- `GET /api/workspaces/:wsId/documents` and `GET /api/user/personal-documents`: pages of 100 (max 200) in keyset order (sort column, then document id; the cursor carries the sort key as text so timestamps keep their microseconds). `q` switches to ranked search within the folder and its subfolders.
- Search reads `document_search` (title + plain Markdown body, `'simple'` text search configuration, `pg_trgm` on titles). The sync server writes it after every store (`sync-server/src/search-index.ts`), together with `documents.word_count`, `size_bytes`, `updated_at` and the live title; the app writes it for content it stores itself (new documents with content, duplicates, imports) and the `search-index-backfill` sweeper indexes documents without a row. An upsert only replaces text of an older `yjs_updates` id. Anonymous documents are never indexed.
- `workspaces.explorer_version` / `users.explorer_version` are bumped by database triggers (migration 0009) on every listed change to folders and documents, in the same transaction as the change. Open explorers poll `GET /api/workspaces/:wsId/version` (or `/api/user/explorer-version`) every 15 s while visible and on focus, and refetch when it moved.

## Bulk actions and rename

- `POST /api/documents/bulk` and `POST /api/folders/bulk-move` decide every item like its single-item route and answer a result per item (partial success). An item someone else moved or deleted meanwhile answers the error codes folder/not-found or docs/not-found; the client shows one note and refreshes.
- `PUT /api/docs/:id/title` renames the row and sets `ymeta.title` through a short sync connection (`server/utils/documents/liveTitle.ts`), so an open editor shows the new name at once; without the sync server it appends the change to the stored log.

## Import jobs

- `import_jobs` / `import_job_items` (`server/db/schema/imports.ts`). The browser sends the manifest (paths and sizes) to `POST /api/imports`; every limit (plan: files, bytes and imports per day; one active import per user) is checked before anything is uploaded. Files go to presigned staging keys `imports/<jobId>/<itemId>`; `start` queues the job.
- The `import-worker` sweeper (`server/utils/imports/importWorker.ts`) re-checks the importer's role, expands zip archives and GitHub repositories (`archive.ts`: entry count, size and ratio limits, unsafe paths skipped; `github.ts`: only `api.github.com` (default branch, the git tree of the requested folder) and `raw.githubusercontent.com` (each importable file of that folder), through `safeFetch`), chooses every document id first so links between imported files can be rewritten, then per file converts (markitdown with `images=1`), stores images as the document's uploads within the image quota (`importImages.ts`), creates the document in the mirrored folder and indexes it. Finished files keep their documents when a job is cancelled or picked up again after a crash.
