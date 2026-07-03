import { describe, it, expect } from 'vitest'
import { TOOL_SCHEMAS, ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../server/utils/agentic/functionTools'

// Contract between our code and the model (Mistral via LiteLLM). The
// Zod schemas in functionTools.ts are the single source of truth:
//   - The model receives the JSON Schema derived from them (validates
//     what it sends us).
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
    expect(parse('web_search', { query: 'latest Mistral pricing' }).success).toBe(true)
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

describe('update_theme schema', () => {
  it('accepts empty object (all fields optional)', () => {
    expect(parse('update_theme', {}).success).toBe(true)
  })

  it('accepts a single nested field (partial update)', () => {
    expect(parse('update_theme', { body: { size: 12 } }).success).toBe(true)
  })

  it('rejects body.size out of range', () => {
    // isValidTheme caps body.size at 6–24; the Zod schema mirrors that
    // so the model gets a schema-level rejection instead of the loop
    // returning a runtime "merged theme failed validation" error.
    expect(parse('update_theme', { body: { size: 100 } }).success).toBe(false)
    expect(parse('update_theme', { body: { size: 2 } }).success).toBe(false)
  })

  it('rejects invalid hex color', () => {
    expect(parse('update_theme', { color: { brand: 'red' } }).success).toBe(false)
    expect(parse('update_theme', { color: { brand: '#zzz' } }).success).toBe(false)
  })

  it('accepts valid hex colors (3-char and 6-char)', () => {
    expect(parse('update_theme', { color: { brand: '#fff' } }).success).toBe(true)
    expect(parse('update_theme', { color: { brand: '#3B82F6' } }).success).toBe(true)
  })

  it('rejects fonts not in the curated enum', () => {
    // Handlers merge on top of current theme and re-validate; if an
    // off-list font slipped through, themeToCss would render the
    // system fallback, not what the user asked for. Keep the gate tight.
    expect(parse('update_theme', { body: { font: 'Times New Roman' } }).success).toBe(false)
    expect(parse('update_theme', { body: { font: 'Comic Sans MS' } }).success).toBe(false)
  })

  it('accepts curated font names', () => {
    expect(parse('update_theme', { body: { font: 'Inter' } }).success).toBe(true)
    expect(parse('update_theme', { body: { font: 'EB Garamond' } }).success).toBe(true)
  })

  it('accepts valid preset ids', () => {
    expect(parse('update_theme', { preset: 'modern' }).success).toBe(true)
    expect(parse('update_theme', { preset: 'academic' }).success).toBe(true)
  })

  it('rejects unknown preset id', () => {
    expect(parse('update_theme', { preset: 'sparkly' }).success).toBe(false)
  })

  it('accepts preset + field override in the same call', () => {
    // Documented shape: preset replaces the base, then other fields
    // merge on top. Schema must not treat these as mutually exclusive.
    expect(parse('update_theme', { preset: 'modern', layout: { columns: '2' } }).success).toBe(true)
  })

  it('accepts numeric-ish fields as string enums (function-call schema quirk)', () => {
    // headings.weight, layout.columns, toc.maxDepth are declared as
    // string enums for function-call schema stability (carried over
    // from pre-Phase-5 Gemini-era constraints); the handler coerces.
    expect(parse('update_theme', { headings: { weight: '600' } }).success).toBe(true)
    expect(parse('update_theme', { layout: { columns: '2' } }).success).toBe(true)
    expect(parse('update_theme', { toc: { maxDepth: '3' } }).success).toBe(true)
  })

  it('rejects numeric-ish fields passed as numbers', () => {
    // If these ever get declared as number enums, the coercion in
    // aiToolAdapter becomes dead code — this test pins the contract.
    expect(parse('update_theme', { headings: { weight: 600 } }).success).toBe(false)
    expect(parse('update_theme', { layout: { columns: 2 } }).success).toBe(false)
  })

  it('rejects page.margin out of range', () => {
    expect(parse('update_theme', { page: { margin: -5 } }).success).toBe(false)
    expect(parse('update_theme', { page: { margin: 200 } }).success).toBe(false)
  })

  it('accepts theme_id as a base source', () => {
    // theme_id is the saved-theme equivalent of `preset` — a string
    // id resolved server-side. Mutual exclusivity with preset is
    // enforced in the handler, not the schema.
    expect(parse('update_theme', { theme_id: 'abc12345xy' }).success).toBe(true)
  })

  it('rejects empty / oversized theme_id', () => {
    expect(parse('update_theme', { theme_id: '' }).success).toBe(false)
    expect(parse('update_theme', { theme_id: 'x'.repeat(65) }).success).toBe(false)
  })

  it('accepts from_workspace_default as a base source', () => {
    expect(parse('update_theme', { from_workspace_default: true }).success).toBe(true)
    expect(parse('update_theme', { from_workspace_default: false }).success).toBe(true)
  })
})

describe('get_theme schema', () => {
  it('accepts an empty object (no args)', () => {
    expect(parse('get_theme', {}).success).toBe(true)
  })
})

describe('list_themes schema', () => {
  it('accepts an empty object (no args)', () => {
    expect(parse('list_themes', {}).success).toBe(true)
  })
})

describe('save_theme_as_preset schema', () => {
  it('accepts a non-empty trimmed name', () => {
    expect(parse('save_theme_as_preset', { name: 'Brand red' }).success).toBe(true)
  })

  it('rejects empty / whitespace-only name', () => {
    expect(parse('save_theme_as_preset', { name: '' }).success).toBe(false)
    expect(parse('save_theme_as_preset', { name: '   ' }).success).toBe(false)
  })

  it('rejects oversized name (>80 chars)', () => {
    expect(parse('save_theme_as_preset', { name: 'x'.repeat(81) }).success).toBe(false)
  })

  it('rejects missing name', () => {
    expect(parse('save_theme_as_preset', {}).success).toBe(false)
  })
})

describe('list_workspace_documents schema', () => {
  it('accepts an empty object (no args)', () => {
    expect(parse('list_workspace_documents', {}).success).toBe(true)
  })
})

describe('view_other_document schema', () => {
  it('accepts a bare doc id', () => {
    expect(parse('view_other_document', { doc_id: 'abc123xyz' }).success).toBe(true)
  })

  it('accepts a full markoto URL', () => {
    expect(parse('view_other_document', { doc_id: 'https://markoto.app/d/abc123xyz' }).success).toBe(true)
  })

  it('rejects empty doc_id', () => {
    expect(parse('view_other_document', { doc_id: '' }).success).toBe(false)
    expect(parse('view_other_document', { doc_id: '   ' }).success).toBe(false)
  })

  it('rejects oversized doc_id (>2048 chars)', () => {
    expect(parse('view_other_document', { doc_id: 'x'.repeat(2049) }).success).toBe(false)
  })

  it('rejects missing doc_id', () => {
    expect(parse('view_other_document', {}).success).toBe(false)
  })

  it('accepts a valid view_range', () => {
    expect(parse('view_other_document', { doc_id: 'a', view_range: [1, 50] }).success).toBe(true)
    expect(parse('view_other_document', { doc_id: 'a', view_range: [1, -1] }).success).toBe(true)
  })

  it('rejects view_range with start < 1', () => {
    expect(parse('view_other_document', { doc_id: 'a', view_range: [0, 10] }).success).toBe(false)
    expect(parse('view_other_document', { doc_id: 'a', view_range: [-1, -1] }).success).toBe(false)
  })

  it('rejects view_range where end < start (and end !== -1)', () => {
    expect(parse('view_other_document', { doc_id: 'a', view_range: [10, 5] }).success).toBe(false)
  })

  it('rejects view_range with wrong tuple length', () => {
    expect(parse('view_other_document', { doc_id: 'a', view_range: [1] }).success).toBe(false)
    expect(parse('view_other_document', { doc_id: 'a', view_range: [1, 2, 3] }).success).toBe(false)
  })
})

describe('update_theme schema (shared-enum drift guards)', () => {
  describe('shared-enum-schema drift guards', () => {
    // These schemas are imported from `shared/types/theme.ts`. If anyone
    // edits the theme schemas they should cascade here automatically.
    // The tests ONLY verify the values listed in DocTheme's enums are
    // accepted — if a new variant is added there, it should be reachable
    // from the AI tool too. If the AI tool path diverges, update the
    // comment in functionTools.ts explaining why.

    it.each(['A4', 'Letter', 'Legal'])('page.size accepts %s (shared PageSizeSchema)', (size) => {
      expect(parse('update_theme', { page: { size } }).success).toBe(true)
    })

    it.each(['portrait', 'landscape'])('page.orientation accepts %s', (orientation) => {
      expect(parse('update_theme', { page: { orientation } }).success).toBe(true)
    })

    it.each(['left', 'justify'])('body.textAlign accepts %s', (textAlign) => {
      expect(parse('update_theme', { body: { textAlign } }).success).toBe(true)
    })

    it.each([
      'github-light', 'github-dark', 'monokai', 'dracula',
      'solarized-light', 'solarized-dark', 'none'
    ])('code.theme accepts %s (shared CodeThemeSchema)', (theme) => {
      expect(parse('update_theme', { code: { theme } }).success).toBe(true)
    })

    it.each(['brand', 'muted', 'none'])('tables.headerBackground accepts %s', (headerBackground) => {
      expect(parse('update_theme', { tables: { headerBackground } }).success).toBe(true)
    })

    it.each(['auto', 'inherit'])('tables.headerTextColor accepts %s', (headerTextColor) => {
      expect(parse('update_theme', { tables: { headerTextColor } }).success).toBe(true)
    })

    it.each(['all', 'horizontal', 'minimal', 'none'])('tables.borders accepts %s', (borders) => {
      expect(parse('update_theme', { tables: { borders } }).success).toBe(true)
    })

    it.each(['border', 'background', 'none'])('blocks.blockquoteStyle accepts %s', (blockquoteStyle) => {
      expect(parse('update_theme', { blocks: { blockquoteStyle } }).success).toBe(true)
    })

    it.each(['default', 'dark', 'forest', 'neutral', 'base'])('mermaid.theme accepts %s', (theme) => {
      expect(parse('update_theme', { mermaid: { theme } }).success).toBe(true)
    })

    it.each(['dotted', 'dashed', 'none'])('toc.leaderStyle accepts %s', (leaderStyle) => {
      expect(parse('update_theme', { toc: { leaderStyle } }).success).toBe(true)
    })

    it('rejects invalid page.size (proves PageSizeSchema is actually wired)', () => {
      // If the `.optional()` chain accidentally dropped the schema, any
      // string would pass. This guard would catch that regression.
      expect(parse('update_theme', { page: { size: 'Tabloid' } }).success).toBe(false)
    })

    it('rejects invalid code.theme', () => {
      expect(parse('update_theme', { code: { theme: 'made-up-theme' } }).success).toBe(false)
    })
  })
})

describe('set_title schema', () => {
  it('accepts a normal title', () => {
    expect(parse('set_title', { title: 'Project Brief' }).success).toBe(true)
  })

  it('rejects empty title', () => {
    expect(parse('set_title', { title: '' }).success).toBe(false)
  })

  it('rejects whitespace-only title (Zod trim reduces to empty)', () => {
    // Zod's .trim() runs before .min(1), so "   " becomes "" and fails.
    // Pins the invariant that the handler never has to deal with blank titles.
    expect(parse('set_title', { title: '   ' }).success).toBe(false)
  })

  it('rejects title > 255 chars', () => {
    expect(parse('set_title', { title: 'x'.repeat(256) }).success).toBe(false)
  })

  it('accepts title at 255-char boundary', () => {
    expect(parse('set_title', { title: 'x'.repeat(255) }).success).toBe(true)
  })

  it('rejects non-string title', () => {
    expect(parse('set_title', { title: 42 }).success).toBe(false)
  })
})

describe('view_image schema', () => {
  it('accepts a relative /api/files path', () => {
    expect(parse('view_image', { src: '/api/files/abc123/def456.png' }).success).toBe(true)
  })

  it('accepts an absolute https URL', () => {
    expect(parse('view_image', { src: 'https://example.com/chart.jpg' }).success).toBe(true)
  })

  it('rejects empty src', () => {
    expect(parse('view_image', { src: '' }).success).toBe(false)
  })

  it('rejects src > 2048 chars (guard against payload bloat)', () => {
    expect(parse('view_image', { src: 'https://example.com/' + 'a'.repeat(2048) }).success).toBe(false)
  })

  it('rejects missing src', () => {
    expect(parse('view_image', {}).success).toBe(false)
  })
})

describe('fetch_url schema', () => {
  it('accepts an absolute https URL', () => {
    expect(parse('fetch_url', { url: 'https://example.com/about' }).success).toBe(true)
  })

  it('accepts a bare hostname (handler adds scheme)', () => {
    // Handler normalises missing schemes to https://, so the schema
    // doesn't strictly require one. Keeps the AI from tripping over
    // the common "write about X from foo.com" phrasing where the user
    // didn't include a scheme.
    expect(parse('fetch_url', { url: 'example.com' }).success).toBe(true)
  })

  it('rejects empty url', () => {
    expect(parse('fetch_url', { url: '' }).success).toBe(false)
  })

  it('rejects whitespace-only url', () => {
    expect(parse('fetch_url', { url: '   ' }).success).toBe(false)
  })

  it('rejects url > 2048 chars', () => {
    expect(parse('fetch_url', { url: 'https://example.com/' + 'a'.repeat(2048) }).success).toBe(false)
  })

  it('rejects missing url', () => {
    expect(parse('fetch_url', {}).success).toBe(false)
  })
})

describe('generate_image schema', () => {
  const valid = { prompt: 'a cat on a skateboard', alt: 'cat skateboarding' }

  it('accepts a full valid payload', () => {
    expect(parse('generate_image', valid).success).toBe(true)
  })

  it('rejects empty prompt', () => {
    expect(parse('generate_image', { ...valid, prompt: '' }).success).toBe(false)
  })

  it('rejects whitespace-only prompt', () => {
    // .trim().min(1) ordering: whitespace collapses then fails min.
    expect(parse('generate_image', { ...valid, prompt: '   ' }).success).toBe(false)
  })

  it('rejects prompt > 2000 chars', () => {
    expect(parse('generate_image', { ...valid, prompt: 'x'.repeat(2001) }).success).toBe(false)
  })

  it('rejects empty alt', () => {
    expect(parse('generate_image', { ...valid, alt: '' }).success).toBe(false)
  })

  it('rejects alt > 200 chars', () => {
    expect(parse('generate_image', { ...valid, alt: 'x'.repeat(201) }).success).toBe(false)
  })

  it('rejects missing required fields', () => {
    expect(parse('generate_image', { alt: 'x' }).success).toBe(false)
    expect(parse('generate_image', { prompt: 'x' }).success).toBe(false)
    expect(parse('generate_image', {}).success).toBe(false)
  })

  it('ignores extra placement-related fields (tool no longer inserts)', () => {
    // Ensures old prompts referencing insert_line/caption still parse —
    // Zod's default is strip-unknown, so extras don't fail validation.
    expect(parse('generate_image', { ...valid, insert_line: 0, caption: 'x' }).success).toBe(true)
  })
})

describe('TOOL_SCHEMAS registry', () => {
  it('registers exactly the declared tools (drift guard against added/removed entries)', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([
      'create_comment',
      'create_document',
      'delete_comment',
      'duplicate_document',
      'export_document_as_markdown',
      'fetch_url',
      'generate_image',
      'get_knowledge_file',
      'get_page_count',
      'get_theme',
      'insert_text',
      'list_my_documents',
      'list_themes',
      'list_workspace_documents',
      'message_to_user',
      'read_comments',
      'replace_text',
      'reply_to_comment',
      'resolve_comment',
      'save_theme_as_preset',
      'search_activity_log',
      'search_knowledge',
      'set_title',
      'update_theme',
      'view_document',
      'view_image',
      'view_other_document',
      'view_pages',
      'web_search'
    ])
  })

  it('registry keys match UNION of ALL + KNOWLEDGE declarations 1:1', () => {
    // Drift guard: if someone adds a new declaration but forgets to
    // register its schema (or vice versa), runLoop.ts's safeParse path
    // silently no-ops for the unregistered half. Knowledge tools are
    // held in a separate declaration array (gated by workspace context)
    // but must still be represented in TOOL_SCHEMAS so the validate
    // path works when they're exposed.
    const declNames = [
      ...ALL_TOOL_DECLARATIONS.map(d => d.name),
      ...KNOWLEDGE_TOOL_DECLARATIONS.map(d => d.name)
    ].sort()
    const schemaNames = Object.keys(TOOL_SCHEMAS).sort()
    expect(schemaNames).toEqual(declNames)
  })
})

describe('ALL_TOOL_DECLARATIONS — model-facing shape', () => {
  it('every declaration has name + description + parameters', () => {
    for (const d of ALL_TOOL_DECLARATIONS) {
      expect(typeof d.name).toBe('string')
      expect(d.name!.length).toBeGreaterThan(0)
      expect(typeof d.description).toBe('string')
      expect(d.description!.length).toBeGreaterThan(0)
      expect(d.parameters).toBeTruthy()
    }
  })

  it('view_document JSON schema exposes view_range as an array, not a tuple', () => {
    // Pre-Phase-5 (Gemini-era) the function-declaration validator
    // rejected draft-7 tuple form (`items: [...]`) and draft 2020-12
    // prefixItems. We've kept the flattened schema post-migration to
    // Mistral so the shape doesn't churn. Regression guard per the
    // comment in functionTools.ts.
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'view_document')
    const props = (decl?.parameters as { properties?: Record<string, unknown> })?.properties
    const vr = props?.view_range as { type?: string, items?: unknown, prefixItems?: unknown }
    expect(vr?.type).toBe('array')
    // Must NOT be an array-of-schemas (tuple form) or 2020-12 prefixItems.
    expect(Array.isArray(vr?.items)).toBe(false)
    expect(vr?.prefixItems).toBeUndefined()
  })

  it('replace_text marks old_str and new_str as required', () => {
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'replace_text')
    const required = (decl?.parameters as { required?: string[] })?.required ?? []
    expect(required).toContain('old_str')
    expect(required).toContain('new_str')
  })

  it('insert_text marks insert_line and insert_text as required', () => {
    const decl = ALL_TOOL_DECLARATIONS.find(d => d.name === 'insert_text')
    const required = (decl?.parameters as { required?: string[] })?.required ?? []
    expect(required).toContain('insert_line')
    expect(required).toContain('insert_text')
  })
})
