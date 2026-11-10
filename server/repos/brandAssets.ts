import { and, asc, eq, sql } from 'drizzle-orm'
import { workspaceBrandAssets } from '../db/schema'
import { useDatabase } from '../utils/database'
import { DuplicateError } from './errors'
import type { BrandAssetFormat, BrandFont } from '~~/shared/config/brandKit'

// Workspace brand kit assets (WP10): fonts and logos. Writers are the
// admin-only routes under /api/workspaces/:wsId/brand; readers are the
// render paths (token endpoint, render bootstrap, the asset routes).

export interface BrandAssetRow {
  id: string
  workspaceId: string
  kind: 'font' | 'image'
  format: BrandAssetFormat
  name: string
  weight: number | null
  style: 'normal' | 'italic' | null
  sizeBytes: number
  s3Key: string
  uploadedBy: number | null
  createdAt: Date
}

const columns = {
  id: workspaceBrandAssets.id,
  workspaceId: workspaceBrandAssets.workspaceId,
  kind: workspaceBrandAssets.kind,
  format: workspaceBrandAssets.format,
  name: workspaceBrandAssets.name,
  weight: workspaceBrandAssets.weight,
  style: workspaceBrandAssets.style,
  sizeBytes: workspaceBrandAssets.sizeBytes,
  s3Key: workspaceBrandAssets.s3Key,
  uploadedBy: workspaceBrandAssets.uploadedBy,
  createdAt: workspaceBrandAssets.createdAt
}

export async function listBrandAssets(workspaceId: string): Promise<BrandAssetRow[]> {
  return useDatabase().select(columns).from(workspaceBrandAssets)
    .where(eq(workspaceBrandAssets.workspaceId, workspaceId))
    .orderBy(asc(workspaceBrandAssets.kind), asc(workspaceBrandAssets.name), asc(workspaceBrandAssets.weight), asc(workspaceBrandAssets.style))
}

/** One asset, only if it belongs to `workspaceId` (tuple key). */
export async function getBrandAsset(workspaceId: string, id: string): Promise<BrandAssetRow | null> {
  return (await useDatabase().select(columns).from(workspaceBrandAssets)
    .where(and(eq(workspaceBrandAssets.workspaceId, workspaceId), eq(workspaceBrandAssets.id, id)))
    .limit(1))[0] ?? null
}

export async function countBrandAssets(workspaceId: string, kind: 'font' | 'image'): Promise<number> {
  const r = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(workspaceBrandAssets)
    .where(and(eq(workspaceBrandAssets.workspaceId, workspaceId), eq(workspaceBrandAssets.kind, kind)))
  return Number(r[0]?.n ?? 0)
}

export async function insertBrandAsset(row: {
  id: string
  workspaceId: string
  kind: 'font' | 'image'
  format: BrandAssetFormat
  name: string
  weight: number | null
  style: 'normal' | 'italic' | null
  sizeBytes: number
  s3Key: string
  uploadedBy: number
  licenceConfirmedAt: Date | null
}): Promise<void> {
  try {
    await useDatabase().insert(workspaceBrandAssets).values(row)
  } catch (e) {
    if ((e as { code?: string })?.code === '23505' || (e as { cause?: { code?: string } })?.cause?.code === '23505') {
      throw new DuplicateError('A font with this family, weight and style')
    }
    throw e
  }
}

export async function deleteBrandAsset(workspaceId: string, id: string): Promise<BrandAssetRow | null> {
  const rows = await useDatabase().delete(workspaceBrandAssets)
    .where(and(eq(workspaceBrandAssets.workspaceId, workspaceId), eq(workspaceBrandAssets.id, id)))
    .returning(columns)
  return rows[0] ?? null
}

/** The workspace's fonts in the shape the renderers take. */
export async function listBrandFonts(workspaceId: string): Promise<BrandFont[]> {
  const rows = await useDatabase().select({
    id: workspaceBrandAssets.id,
    format: workspaceBrandAssets.format,
    name: workspaceBrandAssets.name,
    weight: workspaceBrandAssets.weight,
    style: workspaceBrandAssets.style
  }).from(workspaceBrandAssets)
    .where(and(eq(workspaceBrandAssets.workspaceId, workspaceId), eq(workspaceBrandAssets.kind, 'font')))
    .orderBy(asc(workspaceBrandAssets.name), asc(workspaceBrandAssets.weight))
  return rows.map(r => ({
    file: `${r.id}.${r.format}`,
    family: r.name,
    weight: r.weight ?? 400,
    style: r.style ?? 'normal',
    format: r.format as BrandFont['format']
  }))
}

/** S3 keys of every brand asset of a workspace (workspace deletion). */
export async function listBrandAssetKeys(workspaceId: string): Promise<string[]> {
  return (await useDatabase().select({ k: workspaceBrandAssets.s3Key }).from(workspaceBrandAssets)
    .where(eq(workspaceBrandAssets.workspaceId, workspaceId))).map(r => r.k)
}
