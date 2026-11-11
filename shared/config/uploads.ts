// Size limits of the upload and import endpoints. Not plan limits (those live
// in `tiers.ts`): these are the platform ceilings every plan sits under.
import { MIB } from './units'

/**
 * Largest file `POST /api/import` accepts. Kept in sync with the cap in
 * `markitdown-server/server.py`; the plan's `importMaxBytes` can only lower it.
 */
export const IMPORT_MAX_BYTES = 50 * MIB

/** Largest `.md` / `.markdown` file imported as a document body (one Y.Doc, sync-server cap 16 MiB). */
export const IMPORT_MARKDOWN_MAX_BYTES = 10 * MIB

/**
 * Whole import request: the file plus multipart framing. The Traefik
 * buffering middleware on `/api/import` (prod + self-host compose) and Bun's
 * `maxRequestBodySize` (`server/runtime/bunEntry.ts`) use the same cap.
 */
export const IMPORT_REQUEST_MAX_BYTES = IMPORT_MAX_BYTES + MIB

/** Largest document image (`POST /api/upload/request`). */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * MIB

/** Largest one-shot voice recording (`POST /api/ai/transcribe`), raw audio bytes. */
export const TRANSCRIBE_AUDIO_MAX_BYTES = 5 * MIB
