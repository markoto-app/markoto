import { describe, expect, it } from 'vitest'
import { describeError } from '../../../server/utils/platform/describeError'

describe('describeError', () => {
  it('prints the cause chain with codes, first message line only', () => {
    const pgError = Object.assign(new Error('permission denied for table waitlist_signups'), { code: '42501' })
    const wrapped = new Error('Failed query: delete from "waitlist_signups" where "email" = $1\nparams: someone@example.com', { cause: pgError })
    expect(describeError(wrapped)).toEqual([
      'Failed query: delete from "waitlist_signups" where "email" = $1',
      'caused by: permission denied for table waitlist_signups (code 42501)'
    ])
  })

  it('never prints the parameter line', () => {
    const wrapped = new Error('Failed query: select 1\nparams: secret@example.com')
    expect(describeError(wrapped).join('\n')).not.toContain('secret@example.com')
  })

  it('handles a non-Error value and a non-Error cause', () => {
    expect(describeError('plain text\nsecond line')).toEqual(['plain text'])
    expect(describeError(new Error('outer', { cause: 'inner reason' }))).toEqual(['outer', 'caused by: inner reason'])
  })

  it('stops at the depth limit and ignores non-string codes', () => {
    let e: Error = Object.assign(new Error('level 0'), { code: 7 })
    for (let i = 1; i < 10; i++) e = new Error(`level ${i}`, { cause: e })
    const lines = describeError(e, 3)
    expect(lines).toHaveLength(3)
    expect(describeError(Object.assign(new Error('x'), { code: 7 }))).toEqual(['x'])
  })
})
