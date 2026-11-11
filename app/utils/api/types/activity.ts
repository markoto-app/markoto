import type { ApiResponse } from '~/utils/api/client'

/** One row of a document's activity feed (`GET /api/docs/:docId/activity`). */
export type ActivityEntry = ApiResponse<'/api/docs/:docId/activity', 'get'>[number]
export type ActivityMetadata = NonNullable<ActivityEntry['metadata']>
export type ActivityMetadataAiTool = Extract<ActivityMetadata, { kind: 'ai.tool' }>
