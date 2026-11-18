// Plan classes of the MCP tools. A plan without `mcpWrite`
// (shared/config/tiers.ts: off on the hosted free tier, on everywhere
// by default) gets a read-only MCP server: only `read` tools are listed
// and callable.
//
//   read: reads documents, comments, themes, knowledge, history; no
//           change, no platform cost beyond a database read.
//   write: changes content, comments, themes or creates documents.
//   cost: costs the platform money or renderer time on every call
//           (server render, image generation, web search / page fetch).
//
// Every file in `server/mcp/tools/` must have an entry
// (`tests/unit/mcp/mcpToolClasses.test.ts`); an unknown name is treated as
// `write`, so a tool added without a class is never free by accident.

export type McpToolClass = 'read' | 'write' | 'cost'

export const MCP_TOOL_CLASSES: Readonly<Record<string, McpToolClass>> = {
  view_document: 'read',
  outline: 'read',
  read_section: 'read',
  search_document: 'read',
  list_my_documents: 'read',
  list_workspace_documents: 'read',
  read_comments: 'read',
  get_theme: 'read',
  list_themes: 'read',
  search_knowledge: 'read',
  get_knowledge_file: 'read',
  search_activity_log: 'read',
  view_image: 'read',
  export_document_as_markdown: 'read',

  insert_text: 'write',
  replace_text: 'write',
  replace_section: 'write',
  insert_markdown: 'write',
  move_section: 'write',
  swap_sections: 'write',
  delete_section: 'write',
  set_heading: 'write',
  replace_all: 'write',
  edit_lines: 'write',
  set_title: 'write',
  create_document: 'write',
  duplicate_document: 'write',
  create_comment: 'write',
  reply_to_comment: 'write',
  resolve_comment: 'write',
  delete_comment: 'write',
  update_theme: 'write',
  save_theme_as_preset: 'write',

  generate_image: 'cost',
  export_document_as_pdf: 'cost',
  view_pages: 'cost',
  get_page_count: 'cost',
  web_search: 'cost',
  fetch_url: 'cost'
}

export function mcpToolClass(name: string): McpToolClass {
  return MCP_TOOL_CLASSES[name] ?? 'write'
}

/** Whether a plan with (or without) `mcpWrite` may list and call this tool. */
export function mcpToolAllowed(name: string, mcpWrite: boolean): boolean {
  return mcpWrite || mcpToolClass(name) === 'read'
}
