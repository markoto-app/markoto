import { readFile, stat } from 'node:fs/promises'
import { INSTANCE_BRAND_LOGO_TYPES, instanceBrandLogoExt } from '~~/shared/config/instanceBrand'
import { MIB } from '~~/shared/config/units'
import { instanceBrandParams } from '~~/shared/api/platform'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('instance-brand')

// GET /instance-brand/logo.<ext>: the customer logo of a managed private
// instance: the file the operator names in NUXT_INSTANCE_BRAND_LOGO
// (a path inside the container, e.g. a read-only mount). Only shown as an
// <img>; served with a sandbox CSP so an SVG opened directly can't run
// script on the app's origin.

const MAX_BYTES = MIB

export default defineApiHandler({
  access: allow.public('Customer logo of a managed instance: shown on the sign-in and public pages, so no session'),
  params: instanceBrandParams,
  handler: async ({ event, params }) => {
    const path = useEnv().brand.logo
    const ext = instanceBrandLogoExt(path)
    if (!ext || params.file !== `logo.${ext}`) throw apiError('resource/not-found')
    let bytes: Buffer
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's configured logo file (NUXT_INSTANCE_BRAND_LOGO); the request only picks the extension check
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('not a usable file')
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's configured logo file, as above
      bytes = await readFile(path)
    } catch (e) {
      log.warn('logo not readable', { err: e })
      throw apiError('resource/not-found')
    }
    setHeader(event, 'content-type', INSTANCE_BRAND_LOGO_TYPES[ext])
    setHeader(event, 'x-content-type-options', 'nosniff')
    setHeader(event, 'content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; sandbox`)
    setHeader(event, 'cache-control', 'public, max-age=300')
    return bytes
  }
})
