import { z, type ZodType } from 'zod'
import type { AgenticFunctionDeclaration as FunctionDeclaration, AgenticPart as Part } from '../../agentic/aiTypes'
import type { DocToolContext, MetaToolContext } from '../../agentic/toolContext'
import type { AiToolActivityMetadata } from '~~/shared/contracts/activity'

// One AI tool = one definition: what the model reads (name, description,
// JSON Schema derived from the Zod schema), the runtime validator (the same
// schema), the handler, and the per-tool policy the in-app loop applies
// (call cap, trust-boundary gate, provider requirement, activity row). The
// families under this folder export definitions; `registry.ts` lists them
// in the order the model sees them and is the only dispatch table.

export interface ToolResult {
  content: string
  isError: boolean
  /**
   * Extra content parts (e.g. image inlineData) appended to the user
   * message AFTER the functionResponse so the model can see them on the
   * next turn. The internal `functionResponse` shape
   * is JSON-only — binary data has to ride as a
   * sibling `inlineData` part, which the OpenAI-shape translator in
   * `messageTranslation.ts` then re-emits as a follow-up user message
   * with `image_url` parts.
   */
  extraParts?: Part[]
}

export function toolOk(content: string): ToolResult {
  return { content, isError: false }
}

export function toolError(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * Which session context a handler needs. `doc` handlers read or mutate the
 * Y.js document (or broadcast on its awareness channel); `meta` handlers
 * only touch database rows and external APIs, so MCP can run them for a
 * workspace or a user without opening a document.
 */
export type ToolContextKind = 'doc' | 'meta'

type ContextFor<K extends ToolContextKind> = K extends 'doc' ? DocToolContext : MetaToolContext

/**
 * Taint gate of the in-app loop (`agentic/crossBoundary.ts`): `confirm` =
 * once the session read someone else's text, the invoker must allow the
 * call; `{ urlArg }` = the same, unless the invoker typed that exact URL.
 */
export type TrustBoundary = 'confirm' | { urlArg: string }

/** Provider capability a tool needs; without it the tool is not offered (`filterToolsForProviders`). */
export type ToolRequirement = 'vision' | 'image' | 'webSearch' | 'webFetch'

export interface ToolDefinition<N extends string = string, K extends ToolContextKind = ToolContextKind> {
  name: N
  context: K
  /** The tool description the model reads. Behaviour, not documentation: change it deliberately. */
  description: string
  /** Validates the model's arguments and is the source of the JSON Schema it receives. */
  schema: ZodType<unknown>
  /** Runs the tool. Arguments are validated by the caller (loop: the schema; MCP: its own input schema). */
  run: (ctx: ContextFor<K>, args: unknown) => ToolResult | Promise<ToolResult>
  /** Most calls one in-app loop session may make (cost-amplifying tools); absent = unlimited. */
  sessionCallCap?: number
  trustBoundary?: TrustBoundary
  requires?: ToolRequirement
  /** `ai.tool` activity row for a successful in-app call, for tools otherwise invisible to collaborators. */
  activity?: (args: unknown) => AiToolActivityMetadata
}

interface ToolSpec<N extends string, K extends ToolContextKind, S extends ZodType> extends Omit<ToolDefinition<N, K>, 'run' | 'context' | 'schema'> {
  schema: S
  handler: (ctx: ContextFor<K>, args: z.output<S>) => ToolResult | Promise<ToolResult>
}

function defineTool<const N extends string, K extends ToolContextKind, S extends ZodType>(
  context: K,
  { handler, ...spec }: ToolSpec<N, K, S>
): ToolDefinition<N, K> {
  return {
    ...spec,
    context,
    // The caller validated the arguments against `schema`; the handler sees
    // its parsed shape.
    run: (ctx, args) => handler(ctx, args as z.output<S>)
  }
}

export function defineDocTool<const N extends string, S extends ZodType>(spec: ToolSpec<N, 'doc', S>): ToolDefinition<N, 'doc'> {
  return defineTool('doc', spec)
}

export function defineMetaTool<const N extends string, S extends ZodType>(spec: ToolSpec<N, 'meta', S>): ToolDefinition<N, 'meta'> {
  return defineTool('meta', spec)
}

/** Read a string field from an unknown args bag, trimming to `max`. Returns '' on miss / non-string / non-object. */
export function pickStringArg(args: unknown, key: string, max: number): string {
  if (!args || typeof args !== 'object') return ''
  const v = (args as Record<string, unknown>)[key]
  return typeof v === 'string' ? v.slice(0, max) : ''
}

// FunctionDeclarations (what the model sees). `parameters` accepts any JSON-Schema-shaped object (the SDK types
// it as `unknown`), so we feed it the output of `zodToJsonSchema` directly.
// Descriptions live on the Zod schema and propagate through conversion, so
// we don't duplicate them on the declaration.

export function toFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    // Zod 4 ships `toJSONSchema` natively (the external `zod-to-json-schema`
    // package is typed against Zod 3 and doesn't play nice with v4 internals).
    // `target: 'draft-7'` is the safe default for JSON-Schema-accepting SDKs.
    // Field name MUST be `parameters` (matches both `AgenticFunctionDeclaration`
    // and the OpenAI SDK's `ChatCompletionTool['function'].parameters`).
    // `internalToOpenAITools` reads `d.parameters` and falls back to an
    // EMPTY schema when missing; the model then sees no required fields and
    // emits empty `{}` arg objects, failing Zod validation in `runLoop.ts`
    // for every tool call.
    parameters: z.toJSONSchema(tool.schema, { target: 'draft-7' })
  }
}
