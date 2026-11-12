import * as Sentry from '@sentry/nuxt'
import { AI_SETTINGS_PATH, requireAiProviders } from '../aiProviders/guard'
import type { ResolvedAiProvider } from '../aiProviders/resolve'
import { useValkey } from '../platform/valkey'
import { resolvePayingPlan } from '../billing/billing'
import type { DesignImportExt } from '~~/shared/config/designImport'
import { MINUTE_MS } from '~~/shared/config/units'
import { apiError } from '../api/apiError'
import type { UserScope } from '../../repos/proofs'

// Shared gates of the design-import endpoints.

/**
 * The user's chat provider, which must read images (the original's pages
 * and our renders go to it). No provider → 409 `ai/provider-missing`;
 * a text-only one → 409 `design-import/no-vision`; both link to the AI
 * settings.
 */
export async function requireVisionChatProvider(self: UserScope): Promise<ResolvedAiProvider> {
  // No document / workspace here (the theme panel saves a personal
  // design), so the person's own plan decides (AI by plan).
  const providers = await requireAiProviders(self, 'chat', await resolvePayingPlan(self.userId, null))
  const chat = providers.chat
  if (!chat?.supportsVision) {
    throw apiError('design-import/no-vision', { recovery: { kind: 'link', href: AI_SETTINGS_PATH, labelKey: 'designImport.openAiSettings' } })
  }
  return chat
}

// Pending uploads: what upload-request handed to THIS user, so start only
// ever reads an object it presigned for them (same idea as
// `knowledgePendingUpload.ts`). Claimed atomically (GETDEL); fails closed.

const DESIGN_IMPORT_PENDING_TTL_MS = 6 * MINUTE_MS

export interface PendingDesignUpload {
  stagingKey: string
  ext: DesignImportExt
  mimeType: string
  size: number
}

function pendingKey(userId: number, uploadId: string): string {
  return `design-import-pending:${userId}:${uploadId}`
}

export async function recordPendingDesignUpload(userId: number, uploadId: string, pending: PendingDesignUpload): Promise<void> {
  await useValkey().set(pendingKey(userId, uploadId), JSON.stringify(pending), 'PX', DESIGN_IMPORT_PENDING_TTL_MS)
}

export async function claimPendingDesignUpload(userId: number, uploadId: string): Promise<PendingDesignUpload | null> {
  let raw: string | null
  try {
    raw = await useValkey().getdel(pendingKey(userId, uploadId))
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'design-import', event: 'valkey_unavailable' } })
    return null
  }
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { stagingKey, ext, mimeType, size } = value as Record<string, unknown>
    if (typeof stagingKey !== 'string' || typeof mimeType !== 'string' || typeof size !== 'number') return null
    if (ext !== 'pdf' && ext !== 'docx') return null
    return { stagingKey, ext, mimeType, size }
  } catch {
    return null
  }
}

/** Object key the browser PUTs to (deleted as soon as the server has read it). */
export function designImportStagingKey(userId: number, uploadId: string, ext: DesignImportExt): string {
  return `design-imports/${userId}/staging/${uploadId}.${ext}`
}

/** Exactly the shape above, the orphan sweep deletes only these. */
export const DESIGN_IMPORT_OBJECT_RE = /^design-imports\/\d+\/staging\/[A-Za-z0-9_-]+\.(?:pdf|docx)$/
