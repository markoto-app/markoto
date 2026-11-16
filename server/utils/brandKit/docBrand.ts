import { createHash } from 'node:crypto'
import { getWorkspaceOfDoc } from '../../repos/workspaces'
import { brandFontsOf, listBrandAssetsForDoc } from '../../repos/brandAssets'
import type { DocAccess } from '../../repos/proofs'
import { brandKitAvailable } from './access'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import type { BrandFont } from '~~/shared/config/brandKit'
import type { DocTheme } from '~~/shared/types/theme'
import { compareCodeUnits } from '~~/shared/utils/compareCodeUnits'

// What a document's renderers need from its workspace's brand kit:
// the fonts to declare and, while the design is locked (and the plan
// includes the kit), the locked design (shared/utils/theme/brandLock.ts). Read
// by the token endpoint (editor preview + browser print) and the render
// bootstrap (server PDF / page images, the AI's page views).

export interface DocBrand {
  fonts: BrandFont[]
  /** The workspace design the document must render with; null = its own. */
  lockedTheme: DocTheme | null
  /**
   * Changes whenever the fonts, the logos or the locked design change, part of the
   * server render cache key (a brand change makes no new Y.js row, so the
   * snapshot id alone would serve a stale PDF). Null when the document has
   * no brand inputs (the cache key is then unchanged).
   */
  fingerprint: string | null
}

const NONE: DocBrand = { fonts: [], lockedTheme: null, fingerprint: null }

/** The brand kit of the document's workspace (none outside a workspace, or without a readable document). */
export async function resolveDocBrand(doc: DocAccess<'view'> | null): Promise<DocBrand> {
  if (!doc) return NONE
  const [workspace, assets] = await Promise.all([getWorkspaceOfDoc(doc), listBrandAssetsForDoc(doc)])
  if (!workspace) return NONE
  const workspaceId = workspace.workspaceId
  const fonts = brandFontsOf(assets)
  // Logos count too: deleting one a document's own theme still points at
  // must re-render its cached PDF without it.
  const images = assets.filter(a => a.kind === 'image').map(a => a.id).sort(compareCodeUnits)
  let lockedTheme: DocTheme | null = null
  if (workspace.brandLocked && workspace.defaultTheme && isValidTheme(workspace.defaultTheme) && await brandKitAvailable(workspaceId)) {
    lockedTheme = workspace.defaultTheme
  }
  if (fonts.length === 0 && images.length === 0 && !lockedTheme) return NONE
  const fingerprint = createHash('sha256').update(JSON.stringify({ fonts, images, lockedTheme })).digest('hex').slice(0, 16)
  return { fonts, lockedTheme, fingerprint }
}

/** The client shape (token + meta endpoints). */
export async function docBrandForClient(doc: DocAccess<'view'> | null): Promise<{ fonts: BrandFont[], lockedTheme: DocTheme | null }> {
  const brand = await resolveDocBrand(doc)
  return { fonts: brand.fonts, lockedTheme: brand.lockedTheme }
}
