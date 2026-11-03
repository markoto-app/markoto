// Serves paged.js, Mermaid, KaTeX CSS + fonts, highlight.js themes and the
// web fonts from our own origin under /vendor/ (why: shared/utils/vendorAssets.ts).
//
// At every `nuxt dev` / `nuxt build` / `nuxt prepare` the files are copied
// out of the pinned npm packages into
// `node_modules/.cache/markoto-vendor-assets` (skipped when nothing changed;
// not the build dir, which `nuxt build` / `prepare` empty after module
// setup) and registered as a Nitro public-asset directory,
// so the production build ships them in `.output/public/vendor/`. The copy
// refuses to run — and the build fails — when an installed package's
// version or bytes differ from the version + SRI constants in
// shared/utils/*Assets.ts.
//
// Response headers (CORP, CORS, Cache-Control) are set per path by
// server/plugins/vendor-assets.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { generateVendorAssets, vendorInputsKey } from '../scripts/lib/vendorAssets'
import { VENDOR_BASE } from '../shared/utils/vendorAssets'

export default defineNuxtModule({
  meta: { name: 'markoto-vendor-assets' },
  setup(_options, nuxt) {
    const logger = useLogger('vendor-assets')
    const rootDir = nuxt.options.rootDir
    const outDir = join(rootDir, 'node_modules', '.cache', 'markoto-vendor-assets')
    // Outside outDir: the stamp must not be served.
    const stampFile = `${outDir}.inputs`
    const key = vendorInputsKey(rootDir)
    const upToDate = existsSync(outDir) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === key
    if (!upToDate) {
      const summary = generateVendorAssets(rootDir, outDir)
      writeFileSync(stampFile, key)
      logger.info(`vendored ${summary.files} files (${(summary.bytes / 1024 / 1024).toFixed(1)} MiB) → ${VENDOR_BASE}`)
    }
    nuxt.options.nitro.publicAssets ||= []
    // maxAge 0 = Nitro adds no Cache-Control of its own: it differs between
    // the versioned files and the per-family font stylesheets
    // (server/plugins/vendor-assets.ts).
    nuxt.options.nitro.publicAssets.push({ dir: outDir, baseURL: VENDOR_BASE.replace(/\/$/, ''), maxAge: 0 })
  }
})
