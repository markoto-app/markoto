import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { workspaceBrandAssets } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
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

/**
 * Insert an asset unless the workspace already holds `limit` assets of its
 * kind. Count and insert run under a per-workspace-and-kind advisory lock,
 * so parallel uploads can't overshoot the cap. A font whose family matches
 * an existing one case-insensitively (CSS family matching ignores case),
 * with the same weight and style, is a duplicate.
 */
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
}, limit: number): Promise<'inserted' | 'limit'> {
  try {
    return await useDatabase().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`brand-assets:${row.workspaceId}:${row.kind}`}))`)
      const scope = and(eq(workspaceBrandAssets.workspaceId, row.workspaceId), eq(workspaceBrandAssets.kind, row.kind))
      const counted = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceBrandAssets).where(scope)
      if (Number(counted[0]?.n ?? 0) >= limit) return 'limit'
      if (row.kind === 'font') {
        const same = await tx.select({ id: workspaceBrandAssets.id }).from(workspaceBrandAssets).where(and(
          scope,
          sql`lower(${workspaceBrandAssets.name}) = lower(${row.name})`,
          row.weight === null ? isNull(workspaceBrandAssets.weight) : eq(workspaceBrandAssets.weight, row.weight),
          row.style === null ? isNull(workspaceBrandAssets.style) : eq(workspaceBrandAssets.style, row.style)
        )).limit(1)
        if (same.length > 0) throw new DuplicateError('A font with this family, weight and style')
      }
      await tx.insert(workspaceBrandAssets).values(row)
      return 'inserted'
    })
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

/** The font rows of `assets`, in the renderers' shape, by family then weight. */
export function brandFontsOf(assets: BrandAssetRow[]): BrandFont[] {
  return assets
    .filter(a => a.kind === 'font')
    .sort((a, b) => a.name.localeCompare(b.name) || (a.weight ?? 400) - (b.weight ?? 400))
    .map(r => ({
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
