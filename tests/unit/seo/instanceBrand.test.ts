import { describe, expect, it } from 'vitest'
import { EMPTY_INSTANCE_BRAND, instanceBrandLogoExt, resolveInstanceBrand } from '../../../shared/config/instanceBrand'
import { applyTitleTemplate, DEFAULT_TITLE } from '../../../shared/seo/meta'

// Co-branding of a managed private instance (WP16): the env values the
// operator sets, cleaned up; nothing changes without them.

describe('resolveInstanceBrand', () => {
  it('is empty without configuration', () => {
    expect(resolveInstanceBrand({})).toEqual(EMPTY_INSTANCE_BRAND)
  })

  it('reads name, logo, support contact', () => {
    expect(resolveInstanceBrand({
      NUXT_INSTANCE_BRAND_NAME: '  Kanton Musterstadt ',
      NUXT_INSTANCE_BRAND_LOGO: '/app/branding/logo.SVG',
      NUXT_INSTANCE_SUPPORT_URL: 'https://help.musterstadt.example/markoto',
      NUXT_INSTANCE_SUPPORT_EMAIL: 'servicedesk@musterstadt.example'
    })).toEqual({
      name: 'Kanton Musterstadt',
      logoUrl: '/instance-brand/logo.svg',
      supportUrl: 'https://help.musterstadt.example/markoto',
      supportEmail: 'servicedesk@musterstadt.example'
    })
  })

  it('drops what it can\'t use', () => {
    const b = resolveInstanceBrand({
      NUXT_INSTANCE_BRAND_NAME: `A\u0000B\n${'x'.repeat(80)}`,
      NUXT_INSTANCE_BRAND_LOGO: '/app/branding/logo.gif',
      NUXT_INSTANCE_SUPPORT_URL: 'javascript:alert(1)',
      NUXT_INSTANCE_SUPPORT_EMAIL: 'not an email'
    })
    expect(b.name).toHaveLength(60)
    expect(b.name.startsWith('AB')).toBe(true)
    expect(b).toMatchObject({ logoUrl: null, supportUrl: '', supportEmail: '' })
    expect(instanceBrandLogoExt('/x/logo.webp')).toBe('webp')
    expect(instanceBrandLogoExt('/x/logo')).toBeNull()
    expect(instanceBrandLogoExt(undefined)).toBeNull()
  })
})

describe('title with a brand', () => {
  it('puts the customer after markoto', () => {
    expect(applyTitleTemplate('Q3 report', 'Kanton Musterstadt')).toBe('Q3 report · markoto · Kanton Musterstadt')
    expect(applyTitleTemplate('', 'Kanton Musterstadt')).toBe('markoto · Kanton Musterstadt')
    expect(applyTitleTemplate('Q3 report')).toBe('Q3 report · markoto')
    expect(applyTitleTemplate(null, '')).toBe(DEFAULT_TITLE)
  })
})
