import { describe, it, expect } from 'vitest'
import { corsOriginToCheck, corsRulesProblem } from '../../../server/utils/storage/bucketCors'

// Browser uploads go straight to the bucket with a presigned PUT, so a bucket
// on another origin needs a CORS rule for the site. The documented rule
// (docs/S3-SETUP.md) must pass; a bucket without one must not.

const SITE = 'https://markoto.example'
const DOCUMENTED_RULE = {
  AllowedOrigins: [SITE],
  AllowedMethods: ['GET', 'PUT', 'HEAD'],
  AllowedHeaders: ['Content-Type', 'Content-Length'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3000
}

describe('corsOriginToCheck', () => {
  it('checks the site origin when S3 is on another host', () => {
    expect(corsOriginToCheck('https://markoto.example/', 'https://s3.gra.io.cloud.ovh.net')).toBe(SITE)
  })

  it('skips when the browser reaches S3 under the site origin (self-host SeaweedFS behind Traefik)', () => {
    expect(corsOriginToCheck('https://markoto.example', 'https://markoto.example')).toBeNull()
    expect(corsOriginToCheck('https://markoto.example', 'https://MARKOTO.example/markoto-files')).toBeNull()
  })

  it('skips without a site URL', () => {
    expect(corsOriginToCheck(undefined, 'https://s3.example')).toBeNull()
    expect(corsOriginToCheck('', 'https://s3.example')).toBeNull()
  })
})

describe('corsRulesProblem', () => {
  it('the documented rule covers uploads', () => {
    expect(corsRulesProblem([DOCUMENTED_RULE], SITE)).toBeNull()
  })

  it('no rule at all is a problem', () => {
    expect(corsRulesProblem(undefined, SITE)).toMatch(/no CORS rule on the bucket/)
    expect(corsRulesProblem([], SITE)).toMatch(/no CORS rule on the bucket/)
  })

  it('a rule for another origin does not count', () => {
    expect(corsRulesProblem([{ ...DOCUMENTED_RULE, AllowedOrigins: ['https://staging.markoto.example'] }], SITE)).toMatch(/PUT/)
  })

  it('PUT without Content-Type in the allowed headers fails the preflight', () => {
    expect(corsRulesProblem([{ ...DOCUMENTED_RULE, AllowedHeaders: [] }], SITE)).toMatch(/Content-Type/)
  })

  it('GET missing is reported', () => {
    expect(corsRulesProblem([{ ...DOCUMENTED_RULE, AllowedMethods: ['PUT'] }], SITE)).toMatch(/GET/)
  })

  it('wildcards match like S3 does', () => {
    expect(corsRulesProblem([{ AllowedOrigins: ['https://*.example'], AllowedMethods: ['GET', 'PUT'], AllowedHeaders: ['*'] }], SITE)).toBeNull()
    expect(corsRulesProblem([{ AllowedOrigins: ['*'], AllowedMethods: ['get', 'put'], AllowedHeaders: ['content-*'] }], SITE)).toBeNull()
  })
})
