import { and, eq, lt } from 'drizzle-orm'
import { workspaceKnowledge, workspaceKnowledgeChunks } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor } from './proofs'

// The knowledge ingestion pipeline's writes (convert → chunk → embed →
// store) and the sweep's lookups. Only named background actors run them:
// the pipeline is kicked by the confirm route after the editor's upload
// was proven, and re-kicked by the knowledge sweep.

export interface KnowledgeForProcessing {
  workspaceId: string
  s3Key: string
  sourceExt: string
  status: 'processing' | 'ready' | 'failed'
}

export interface KnowledgeChunkInput {
  chunkIndex: number
  content: string
  tokens: number
  embedding: number[]
}

export async function getKnowledgeForProcessing(_by: SystemActor, knowledgeId: string): Promise<KnowledgeForProcessing | null> {
  const row = (await useDatabase()
    .select({ workspaceId: workspaceKnowledge.workspaceId, s3Key: workspaceKnowledge.s3Key, sourceExt: workspaceKnowledge.sourceExt, status: workspaceKnowledge.status })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1))[0]
  return row ?? null
}

/** Still there? The user may delete the file while it converts or embeds. */
export async function knowledgeRowExists(_by: SystemActor, knowledgeId: string): Promise<boolean> {
  const rows = await useDatabase().select({ id: workspaceKnowledge.knowledgeId })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1)
  return rows.length > 0
}

/**
 * Replace the file's chunks. Deliberately not one transaction: pg + HNSW
 * writes don't play well inside long transactions, and a partial insert is
 * recoverable (a re-process deletes by knowledge id first).
 */
export async function replaceKnowledgeChunks(_by: SystemActor, knowledgeId: string, workspaceId: string, chunks: readonly KnowledgeChunkInput[]): Promise<void> {
  const db = useDatabase()
  await db.delete(workspaceKnowledgeChunks).where(eq(workspaceKnowledgeChunks.knowledgeId, knowledgeId))
  if (chunks.length === 0) return
  await db.insert(workspaceKnowledgeChunks).values(chunks.map(c => ({ knowledgeId, workspaceId, ...c })))
}

export async function markKnowledgeReady(_by: SystemActor, knowledgeId: string, result: {
  chunkCount: number
  tokenCount: number
  markdownCache: string
  embeddingVersion: string
}): Promise<void> {
  await useDatabase().update(workspaceKnowledge).set({
    status: 'ready' as const,
    ...result,
    processedAt: new Date(),
    errorMessage: null
  }).where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
}

export async function markKnowledgeFailed(_by: SystemActor, knowledgeId: string, message: string): Promise<void> {
  await useDatabase().update(workspaceKnowledge).set({
    status: 'failed' as const,
    errorMessage: message,
    processedAt: new Date()
  }).where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
}

/** Files in `status` created before `cutoff` (stuck processing, expired failures). */
export async function listKnowledgeInStatusSince(_by: SystemActor, status: 'processing' | 'failed', cutoff: Date): Promise<Array<{ knowledgeId: string, workspaceId: string }>> {
  return useDatabase().select({ knowledgeId: workspaceKnowledge.knowledgeId, workspaceId: workspaceKnowledge.workspaceId })
    .from(workspaceKnowledge)
    .where(and(eq(workspaceKnowledge.status, status), lt(workspaceKnowledge.createdAt, cutoff)))
}
