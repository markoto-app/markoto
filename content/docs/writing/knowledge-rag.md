---
title: Ask the AI about a file you uploaded
description: Upload PDFs / Word docs / HTML to a workspace, the AI grounds its answers in your files via hybrid retrieval.
category: writing
order: 6
featured: true
---

# Ask the AI about a file you uploaded

Workspaces have a Knowledge tab — drop in PDFs, Word docs, HTML
exports, the team's RFCs, customer FAQs. markoto converts them to
markdown via markitdown, splits them into heading-aware chunks, embeds
each chunk with Gemini, and indexes both the vector AND a tsvector for
hybrid retrieval. The AI gets a `search_knowledge` tool that hits this
index automatically when your prompt smells like a knowledge question.

This walkthrough uploads a Q3 launch postmortem and asks the AI to
summarise what it said about staged rollouts. The AI returns specific
facts from the file — none of which exist in its training data.

::flow{id="knowledge-grounded-ai" hide-title}
::

## What just happened

You uploaded a file, watched it process, then asked the AI a question
that only the file knows the answer to. The pipeline:

1. **Upload** — presigned PUT to S3 (browser ↔ S3 directly, never
   through markoto's app server).
2. **Confirm + sniff** — `POST .../confirm` HEADs the object,
   sniffs magic bytes via `file-type`, advisory-locks the workspace,
   re-checks caps, inserts the row.
3. **Process** — `markitdown` (Python sidecar wrapping Microsoft's
   open-source library) converts the file to markdown.
4. **Chunk** — heading-aware splitter, capped at 300 chunks per file
   with sentinel truncation.
5. **Embed** — Gemini's `gemini-embedding-2-preview` model, 768-d
   via output-dimensionality MRL truncation. One vector per chunk,
   bounded concurrency of 5 in-flight embedding requests.
6. **Index** — pgvector HNSW for cosine search + GIN on tsvector
   for BM25-style lexical match.

When you asked the question, the AI's agentic loop chose
`search_knowledge`, which fired BOTH a vector query and a lexical
query in parallel against the chunk index. Results merged via
**Reciprocal Rank Fusion** (k=60) — chunks in both result sets get a
double contribution; chunks in only one still place reasonably.

The AI got the top-K chunks back as JSON, folded them into its reply,
and committed the answer into the doc.

## Limits + safety

| Layer | Cap |
|---|---|
| Files per workspace | 500 |
| Bytes per workspace | 1 GB |
| Files per user (across workspaces) | 100 |
| Bytes per user (across workspaces) | 2 GB |
| Bytes per file | 25 MB |
| Chunks per file | 300 (sentinel-truncated) |
| Concurrent uploads (Valkey-tracked) | per-workspace + per-user |
| Upload-request rate limit | 30 / user / minute |

Mid-session membership drift is handled defensively: the AI session's
`workspaceId` is resolved once at session open, but the knowledge
tool handlers re-check `getMemberRole(workspaceId, userId)` on every
invocation. An admin demoting you mid-session immediately revokes
further knowledge access at the next tool call.

## What's next

- [Polish the AI's grounded answer as a PDF](/docs/import-export/polished-pdf).
- [Tell the AI who you're writing for](/docs/writing/document-context) — combine
  audience steering + knowledge grounding for in-domain prose.
