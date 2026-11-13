import type { ApiResponse } from '~/utils/api/client'

/** One of the caller's saved theme presets (`GET /api/themes`). */
export type SavedTheme = ApiResponse<'/api/themes', 'get'>['themes'][number]
