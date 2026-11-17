import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { coerceToolArgs } from '../../../server/utils/agentic/loop/argCoercion'

// Tool-argument repair before Zod validation: numbers sent as strings,
// `null` for an optional field, objects / arrays sent as JSON strings.
// Conservative: a value only changes into the type the schema asks for.

const schema = z.object({
  insert_line: z.number().int().min(0),
  limit: z.number().int().min(1).optional(),
  view_range: z.array(z.number().int()).min(2).max(2).optional(),
  is_question: z.boolean().optional(),
  label: z.string().optional(),
  required_text: z.string(),
  maybe: z.string().nullable().optional(),
  theme: z.object({ page: z.object({ margin: z.number().optional() }).optional() }).optional(),
  piped: z.string().transform(s => s.toUpperCase()).optional()
})

describe('coerceToolArgs', () => {
  it('turns numeric strings into numbers where the schema wants a number', () => {
    expect(coerceToolArgs(schema, { insert_line: '12', limit: ' 3 ', required_text: 'x' }))
      .toEqual({ insert_line: 12, limit: 3, required_text: 'x' })
    expect(coerceToolArgs(schema, { insert_line: '1.5', required_text: '7' }))
      .toEqual({ insert_line: 1.5, required_text: '7' })
  })

  it('leaves non-numeric strings and string fields alone', () => {
    const args = { insert_line: 'twelve', required_text: '12', label: '3' }
    expect(coerceToolArgs(schema, args)).toBe(args)
    expect(schema.safeParse(coerceToolArgs(schema, args)).success).toBe(false)
  })

  it('drops null for an optional field, keeps it for a nullable or required one', () => {
    expect(coerceToolArgs(schema, { insert_line: 1, required_text: 'x', limit: null, label: null }))
      .toEqual({ insert_line: 1, required_text: 'x' })
    expect(coerceToolArgs(schema, { insert_line: 1, required_text: 'x', maybe: null }))
      .toEqual({ insert_line: 1, required_text: 'x', maybe: null })
    const requiredNull = { insert_line: null, required_text: 'x' }
    expect(coerceToolArgs(schema, requiredNull)).toBe(requiredNull)
  })

  it('parses stringified arrays and objects, then coerces inside them', () => {
    expect(coerceToolArgs(schema, { insert_line: 0, required_text: 'x', view_range: '[10, "20"]' }))
      .toEqual({ insert_line: 0, required_text: 'x', view_range: [10, 20] })
    expect(coerceToolArgs(schema, { insert_line: 0, required_text: 'x', theme: '{"page":{"margin":"12"}}' }))
      .toEqual({ insert_line: 0, required_text: 'x', theme: { page: { margin: 12 } } })
    expect(coerceToolArgs(schema, { insert_line: 0, required_text: 'x', view_range: ['1', '-1'] }))
      .toEqual({ insert_line: 0, required_text: 'x', view_range: [1, -1] })
  })

  it('does not parse a JSON string of the wrong shape', () => {
    const args = { insert_line: 0, required_text: 'x', view_range: '{"a":1}', theme: '[1]' }
    expect(coerceToolArgs(schema, args)).toBe(args)
  })

  it('accepts "true" / "false" for a boolean', () => {
    expect(coerceToolArgs(schema, { insert_line: 0, required_text: 'x', is_question: 'false' }))
      .toEqual({ insert_line: 0, required_text: 'x', is_question: false })
  })

  it('unwraps a whole argument object sent as a JSON string', () => {
    expect(coerceToolArgs(schema, '{"insert_line":"4","required_text":"x"}'))
      .toEqual({ insert_line: 4, required_text: 'x' })
  })

  it('ignores unknown keys and transform inputs it cannot type', () => {
    const args = { insert_line: 0, required_text: 'x', extra: '5', piped: 'a' }
    expect(coerceToolArgs(schema, args)).toBe(args)
  })

  it('never throws on odd input', () => {
    expect(coerceToolArgs(schema, null)).toBe(null)
    expect(coerceToolArgs(schema, 42)).toBe(42)
    expect(coerceToolArgs(z.string(), 'x')).toBe('x')
  })

  it('works on schemas with object-level refinements (Zod 4 keeps them as checks)', () => {
    const refined = z.object({ n: z.number() }).refine(v => v.n > 0)
    expect(coerceToolArgs(refined, { n: '2' })).toEqual({ n: 2 })
  })
})
