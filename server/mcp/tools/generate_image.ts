import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { MCP_RATE_LIMITS } from '../lib/mcpGate'

// Generates an image via BFL FLUX.2 [pro] EU-pinned through LiteLLM,
// uploads to S3 under `docs/{docId}/...`, returns the markdown
// reference. `access: 'edit'` because the operation creates an S3
// asset attributed to the doc (uploads row + storage cost) — only
// editors should be able to mint these.
//
// Billing: hits LiteLLM via the user's virtualKey on ToolContext.
// Default 1024² @ $0.030; non-square (width/height args) prices
// linearly by megapixel.
export default buildDocBoundTool({
  name: 'generate_image',
  description: 'Generate a photo or illustration from a text prompt and upload it as an asset of the doc. Returns the markdown reference (e.g. "![alt](/api/files/.../x.png)") — pair with `insert_text` or `replace_text` to place it.',
  // Writes an asset into a document the user can edit and spends their
  // AI budget — a document write, not a web read.
  scope: 'documents:write',
  access: 'edit',
  limit: MCP_RATE_LIMITS.generateImagePerUser,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id the generated image will belong to (asset stored at docs/{doc_id}/...).'),
    prompt: z.string().trim().min(1).max(2000).describe('Detailed description of the image to generate. Be specific about subject, style, composition, mood.'),
    alt: z.string().trim().min(1).max(200).describe('Concise alt text (1–200 chars) for the markdown image reference.'),
    width: z.number().int().min(512).max(1536).optional().describe('Output image width in pixels (multiple of 32, 512-1536). Default 1024.'),
    height: z.number().int().min(512).max(1536).optional().describe('Output image height in pixels (multiple of 32, 512-1536). Default 1024.')
  }
})
