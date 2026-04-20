import { describe, it, expect } from 'vitest'
import { TOOL_SCHEMAS, ALL_TOOL_DECLARATIONS } from '../../server/utils/agentic/functionTools'

// Contract between our code and Gemini. The Zod schemas in functionTools.ts
// are the single source of truth:
//   - Gemini receives the JSON Schema derived from them (validates what it
//     sends us).
//   - runLoop.ts runs safeParse() before dispatching (second line of defence
//     against malformed args slipping through).
//
// These tests pin the schema shapes so a future change to ANY of them is an
// explicit edit, not an accidental relaxation.

function parse(name: string, input: unknown) {
  const schema = TOOL_SCHEMAS[name]
  if (!schema) throw new Error(`No schema registered for ${name}`)
  return schema.safeParse(input)
}

describe('view_document schema', () => {
  it('accepts empty object (view_range is optional)', () => {
    expect(parse('view_document', {}).success).toBe(true)
  })

  it('accepts a valid [start, end] tuple', () => {
    expect(parse('view_document', { view_range: [1, 10] }).success).toBe(true)
  })

  it('accepts [start, -1] sentinel for "to end"', () => {
    expect(parse('view_document', { view_range: [1, -1] }).success).toBe(true)
  })

  it('rejects view_range with 1 element', () => {
    expect(parse('view_document', { view_range: [1] }).success).toBe(false)
  })

  it('rejects view_range with 3 elements', () => {
    expect(parse('view_document', { view_range: [1, 2, 3] }).success).toBe(false)
  })

  it('rejects non-integer view_range entries', () => {
    expect(parse('view_document', { view_range: [1.5, 10] }).success).toBe(false)
  })

  it('rejects string view_range entries', () => {
    expect(parse('view_document', { view_range: ['1', '10'] }).success).toBe(false)
  })
})

describe('replace_text schema', () => {
  it('accepts a valid pair', () => {
    expect(parse('replace_text', { old_str: 'foo', new_str: 'bar' }).success).toBe(true)
  })

  it('accepts empty new_str (delete operation)', () => {
    // Delete-only is a supported operation. If the schema ever required
    // new_str.min(1), the model would lose the ability to remove text.
    expect(parse('replace_text', { old_str: 'foo', new_str: '' }).success).toBe(true)
  })

  it('rejects empty old_str', () => {
    // Schema-level guard: old_str MUST be non-empty. Handler also checks,
    // but catching here means the model gets a schema-validation message
    // (which it understands better than a runtime error string).
    expect(parse('replace_text', { old_str: '', new_str: 'x' }).success).toBe(false)
  })

  it('rejects missing old_str', () => {
    expect(parse('replace_text', { new_str: 'x' }).success).toBe(false)
  })

  it('rejects missing new_str', () => {
    expect(parse('replace_text', { old_str: 'x' }).success).toBe(false)
  })

  it('rejects non-string types', () => {
    expect(parse('replace_text', { old_str: 1, new_str: 'x' }).success).toBe(false)
    expect(parse('replace_text', { old_str: 'x', new_str: 42 }).success).toBe(false)
  })
})

describe('insert_text schema', () => {
  it('accepts a valid pair', () => {
    expect(parse('insert_text', { insert_line: 0, insert_text: 'hi' }).success).toBe(true)
  })

  it('accepts insert_text = "" (empty insert still valid)', () => {
    // Handler auto-adds a newline, so inserting "" effectively inserts a
    // blank line. Not useful but not forbidden — keep behaviour explicit.
    expect(parse('insert_text', { insert_line: 0, insert_text: '' }).success).toBe(true)
  })

  it('rejects negative insert_line', () => {
    expect(parse('insert_text', { insert_line: -1, insert_text: 'x' }).success).toBe(false)
  })

  it('rejects non-integer insert_line', () => {
    expect(parse('insert_text', { insert_line: 1.5, insert_text: 'x' }).success).toBe(false)
  })

  it('rejects string insert_line', () => {
    expect(parse('insert_text', { insert_line: '1', insert_text: 'x' }).success).toBe(false)
  })

  it('rejects missing insert_line', () => {
    expect(parse('insert_text', { insert_text: 'x' }).success).toBe(false)
  })

  it('rejects missing insert_text', () => {
    expect(parse('insert_text', { insert_line: 0 }).success).toBe(false)
  })
})

describe('web_search schema', () => {
  it('accepts a non-empty query', () => {
    expect(parse('web_search', { query: 'latest Gemini pricing' }).success).toBe(true)
  })

  it('rejects empty query', () => {
    expect(parse('web_search', { query: '' }).success).toBe(false)
  })

  it('rejects missing query', () => {
    expect(parse('web_search', {}).success).toBe(false)
  })

  it('rejects non-string query', () => {
    expect(parse('web_search', { query: 123 }).success).toBe(false)
  })
})

describe('TOOL_SCHEMAS registry', () => {
  it('registers exactly the four declared tools', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([
      'insert_text',
      'replace_text',
      'view_document',
      'web_search'
    ])
  })

  it('registry keys match ALL_TOOL_DECLARATIONS names 1:1', () => {
    // Drift guard: if someone adds a new declaration but forgets to
    // register its schema (or vice versa), runLoop.ts's safeParse path
    // silently no-ops for the unregistered half. Pin them together.
    const declNames = ALL_TOOL_DECLARATIONS.map(d => d.name).sort()
    const schemaNames = Object.keys(TOOL_SCHEMAS).sort()
    expect(schemaNames).toEqual(declNames)
  })
})

describe('ALL_TOOL_DECLARATIONS — Gemini-facing shape', () => {
  it('every declaration has name + description + parametersJsonSchema', () => {
    for (const d of ALL_TOOL_DECLARATIONS) {
      expect(typeof d.name).toBe('string')
      expect(d.name!.length).toBeGreaterThan(0)
      expect(typeof d.description).toBe('string')
      expect(d.description!.length).toBeGreaterThan(0)
      expect(d.parametersJsonSchema).toBeTruthy()
    }
  })

  it('view_document JSON schema exposes view_range as an array, not a tuple', () => {
    // Gemini's validator rejects draft-7 tuple form (`items: [...]`) and
    // draft 2020-12 prefixItems. The schema must flatten to a single
    // items schema. Regression guard per the comment in functionTools.ts.
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'view_document')
    const props = (decl?.parametersJsonSchema as { properties?: Record<string, unknown> })?.properties
    const vr = props?.view_range as { type?: string, items?: unknown, prefixItems?: unknown }
    expect(vr?.type).toBe('array')
    // Must NOT be an array-of-schemas (tuple form) or 2020-12 prefixItems.
    expect(Array.isArray(vr?.items)).toBe(false)
    expect(vr?.prefixItems).toBeUndefined()
  })

  it('replace_text marks old_str and new_str as required', () => {
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'replace_text')
    const required = (decl?.parametersJsonSchema as { required?: string[] })?.required ?? []
    expect(required).toContain('old_str')
    expect(required).toContain('new_str')
  })

  it('insert_text marks insert_line and insert_text as required', () => {
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'insert_text')
    const required = (decl?.parametersJsonSchema as { required?: string[] })?.required ?? []
    expect(required).toContain('insert_line')
    expect(required).toContain('insert_text')
  })
})
