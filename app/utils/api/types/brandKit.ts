import type { ApiResponse } from '~/utils/api/client'

/** The workspace brand kit as members and admins see it (`GET /api/workspaces/:wsId/brand`). */
export type BrandKit = ApiResponse<'/api/workspaces/:wsId/brand', 'get'>
export type BrandKitFontRow = BrandKit['fonts'][number]
