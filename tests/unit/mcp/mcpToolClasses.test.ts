import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_TOOL_CLASSES, mcpToolAllowed, mcpToolClass } from '../../../server/mcp/lib/toolClasses'

// Read-only MCP for plans without `mcpWrite` (server/mcp/lib/toolClasses.ts).
// A tool added without a class must not slip through as "read".

const TOOL_DIR = resolve(__dirname, '../../../server/mcp/tools')
const toolNames = readdirSync(TOOL_DIR).filter(f => f.endsWith('.ts')).map(f => f.replace(/\.ts$/, ''))

describe('MCP tool classes', () => {
  it('every tool in server/mcp/tools has a class', () => {
    const missing = toolNames.filter(name => !(name in MCP_TOOL_CLASSES))
    expect(missing).toEqual([])
  })

  it('lists no class for a tool that does not exist', () => {
    const stale = Object.keys(MCP_TOOL_CLASSES).filter(name => !toolNames.includes(name))
    expect(stale).toEqual([])
  })

  it('treats an unknown tool as write (never free by accident)', () => {
    expect(mcpToolClass('brand_new_tool')).toBe('write')
    expect(mcpToolAllowed('brand_new_tool', false)).toBe(false)
  })

  it('read-only plans keep exactly the read tools', () => {
    const allowed = toolNames.filter(name => mcpToolAllowed(name, false)).sort()
    const reads = Object.entries(MCP_TOOL_CLASSES).filter(([, c]) => c === 'read').map(([n]) => n).sort()
    expect(allowed).toEqual(reads)
    expect(allowed).toContain('view_document')
    expect(allowed).not.toContain('replace_text')
    expect(allowed).not.toContain('generate_image')
    expect(allowed).not.toContain('web_search')
  })

  it('plans with mcpWrite keep every tool', () => {
    for (const name of toolNames) expect(mcpToolAllowed(name, true), name).toBe(true)
  })

  it('document search and folder listing are reads; filing and creating folders are writes', () => {
    expect(mcpToolClass('search_documents')).toBe('read')
    expect(mcpToolClass('list_folders')).toBe('read')
    expect(mcpToolAllowed('move_document', false)).toBe(false)
    expect(mcpToolAllowed('create_folder', false)).toBe(false)
  })

  it('every render / image / web tool is classed as cost', () => {
    for (const name of ['export_document_as_pdf', 'view_pages', 'get_page_count', 'generate_image', 'web_search', 'fetch_url']) {
      expect(mcpToolClass(name), name).toBe('cost')
    }
  })
})
