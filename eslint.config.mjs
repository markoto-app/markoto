// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    // Galaxy collections / roles fetched into infra/collections/ ship JS
    // fixtures + sample policies that aren't ours to lint. Same for
    // infra/.ansible/ runtime cache.
    ignores: [
      'infra/collections/**',
      'infra/.ansible/**'
    ]
  }
)
