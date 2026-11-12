import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Fetches an image and returns it as inline base64 in the tool
// response. Two source kinds:
//   - Internal: `/api/files/{docId}/{fileId}`: needs view access to
//     the SAME doc (the handler asserts docId matches via
//     parseInternalFileRef).
//   - External: `http(s)://…`: SSRF-guarded by `assertSafeUrl`.
// MIME allowlist (PNG/JPEG/GIF/WebP/SVG), 5 MiB cap, 10s timeout.
export default buildDocBoundTool({
  name: 'view_image',
  description: 'Fetch an image (internal /api/files/* upload OR external https URL) and inline its bytes into the tool response. Use when you need to reason about what an image actually depicts, alt text, figure summary, chart description.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc the image belongs to (internal URLs MUST match this id; external URLs are doc-scoped for spend attribution).'),
    src: z.string().min(1).max(2048).describe('The image URL or path exactly as it appears in the markdown (e.g. "/api/files/abc/def.png" for internal uploads, "https://example.com/chart.jpg" for external).')
  }
})
