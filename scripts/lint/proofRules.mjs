// @ts-check
// ESLint rules guarding the capability proofs (docs/SECURITY-HARDENING.md,
// tenancy). Wired in eslint.config.mjs, tested in
// tests/unit/access/proofRules.test.ts.
//
//   no-proof-forgery     (type-aware) no value reaches a proof-typed slot
//                        through a type assertion or an `any` / `never`
//                        value: the compiler is the gate everywhere else.
//   proof-entry-imports  the access-layer functions that turn a user id (or
//                        a decision the caller made) into a proof are used
//                        only by the callers listed in PROOF_ENTRY_CALLERS.

import ts from 'typescript'

const PROOF_CLASSES = new Set(['DocAccess', 'WorkspaceAccess', 'UserScope', 'AdminActor', 'SystemActor'])
const MINT_FILE = /(^|\/)server\/repos\/proofs\/mint\.ts$/

/**
 * @param {ts.Symbol | undefined} symbol
 * @returns {boolean}
 */
function isProofSymbol(symbol) {
  if (!symbol || !PROOF_CLASSES.has(symbol.getName())) return false
  return (symbol.getDeclarations() ?? []).some(d => MINT_FILE.test(d.getSourceFile().fileName.replaceAll('\\', '/')))
}

/**
 * Does `type` name a proof, directly, as a union / intersection member, as a
 * type argument (`Promise<DocAccess>`) or as a property of an object type
 * (`{ access: DocAccess }`)? Bounded depth: proofs sit near the surface of
 * the parameter types that carry them.
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} type
 * @param {number} depth
 * @param {Set<ts.Type>} seen
 * @returns {boolean}
 */
function containsProof(checker, type, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(type)) return false
  seen.add(type)
  if (isProofSymbol(type.getSymbol()) || isProofSymbol(type.aliasSymbol)) return true
  if (type.isUnionOrIntersection()) return type.types.some(t => containsProof(checker, t, depth, seen))
  if (!(type.flags & ts.TypeFlags.Object)) return false
  const objectType = /** @type {ts.ObjectType} */ (type)
  if (objectType.objectFlags & ts.ObjectFlags.Reference) {
    const args = checker.getTypeArguments(/** @type {ts.TypeReference} */ (objectType))
    if (args.some(t => containsProof(checker, t, depth + 1, seen))) return true
  }
  // Library and DOM types (Promise, Map, H3Event, ...) do not hold proofs as
  // properties; walking them only costs time.
  const decl = type.getSymbol()?.getDeclarations()?.[0]
  if (decl && /node_modules|\/typescript\/lib\//.test(decl.getSourceFile().fileName)) return false
  return checker.getPropertiesOfType(type).slice(0, 64).some(p => containsProof(checker, checker.getTypeOfSymbol(p), depth + 1, seen))
}

/** @param {ts.Type} type */
const isAnyOrNever = type => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) !== 0

/** @type {import('eslint').Rule.RuleModule} */
const noProofForgery = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      cast: 'A type assertion to a proof type forges a capability proof. Proofs come from the access layer (handler ctx, tool context, server/utils/access).',
      unsafe: 'An `any` / `never` value where a capability proof is expected bypasses the proof check. Pass a proof the access layer minted.'
    }
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('markoto/no-proof-forgery needs type information (parserOptions.project)')
    }
    const checker = services.program.getTypeChecker()
    /** @param {any} node */
    const tsNode = node => services.esTreeNodeToTSNodeMap.get(node)

    /**
     * An `any` / `never` expression in a position whose contextual type is
     * (or holds) a proof: `repo(x as never)`, `repo(JSON.parse(s))`,
     * `const p: DocAccess = Object.create(...)`.
     * @param {any} node
     */
    function checkValue(node) {
      if (!node || node.type === 'SpreadElement') return
      const expr = tsNode(node)
      if (!expr || !isAnyOrNever(checker.getTypeAtLocation(expr))) return
      const contextual = checker.getContextualType(expr)
      if (contextual && containsProof(checker, contextual)) context.report({ node, messageId: 'unsafe' })
    }

    /** @param {any} node */
    function checkAssertion(node) {
      const assertion = tsNode(node)
      if (!assertion || !assertion.type) return
      const target = checker.getTypeFromTypeNode(assertion.type)
      if (containsProof(checker, target)) context.report({ node, messageId: 'cast' })
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      /** @param {any} node */
      'CallExpression, NewExpression'(node) { for (const arg of node.arguments) checkValue(arg) },
      /** @param {any} node */
      VariableDeclarator(node) { checkValue(node.init) },
      /** @param {any} node */
      'ObjectExpression > Property'(node) { checkValue(node.value) },
      /** @param {any} node */
      ReturnStatement(node) { checkValue(node.argument) },
      /** @param {any} node */
      AssignmentExpression(node) { checkValue(node.right) },
      /** @param {any} node */
      'ArrayExpression'(node) { for (const el of node.elements) checkValue(el) }
    }
  }
}

// ---------- who may call the proof entry points ----------

const ACCESS_LAYER = '^server/utils/access/'
const POLICY = '^server/utils/api/policy\\.ts$'
const POLICY_DOC = '^server/utils/api/policyDoc\\.ts$'
const POLICY_WORKSPACE = '^server/utils/api/policyWorkspace\\.ts$'
const MCP_AUTH = '^server/utils/mcp/mcpAuth\\.ts$'
const MCP_WRAPPER = '^server/mcp/lib/wrapDocBoundTool\\.ts$'
// The MCP tool that reaches a second document (the export source) outside the wrapper.
const MCP_EXPORT_TOOL = '^server/mcp/tools/export_document_as_pdf\\.ts$'
// The AI session: its start (document + workspace of the session) and the
// tools that reach another document or the workspace knowledge per call.
const AI_SESSION = ['^server/utils/agentic/sessionGuard\\.ts$', '^server/utils/agentic/sessions/sessionSetup\\.ts$']
const AI_TOOLS = ['^server/utils/ai/tools/libraryTools\\.ts$', '^server/utils/ai/tools/knowledgeTools\\.ts$']
// Delegated AI jobs run after the session that started them; the engine
// re-proves the initiator's edit membership before it runs a job.
const AI_JOBS = '^server/utils/ai/jobs/engine\\.ts$'
// Creation flows: the creator holds every right on the row it just inserted,
// and proves membership of the target workspace from its own UserScope.
const CREATION = ['^server/utils/documents/createDocument\\.ts$', '^server/utils/documents/duplicateDocument\\.ts$']
// `ctx.prove` (server/utils/api/policyProver.ts): the policies' prover for a
// second object, bound to the user the policy authenticated.
const POLICY_PROVER = '^server/utils/api/policyProver\\.ts$'
// The explorer's actions on many items (each decided like the single-item
// route) and its folder routes; bulk imports (the target scope, the editor's
// single-file import into a document the caller may write).
const EXPLORER = '^server/utils/explorer/'
const IMPORTS = '^server/utils/imports/createImportJob\\.ts$'
const IMPORT_ROUTE = '^server/api/import\\.post\\.ts$'
const IMPORT_WORKER = '^server/utils/imports/importWorker\\.ts$'

/**
 * Each entry point that mints a proof from something the caller vouches for
 * (a user id, or a decision it already made), and the files allowed to call
 * it. The access layer itself is always allowed. `proveWorkspaceDoc` is not
 * listed: it derives a document proof from a workspace proof the caller
 * already holds, so it cannot widen access.
 * @type {Record<string, string[]>}
 */
export const PROOF_ENTRY_CALLERS = {
  // Turn a decision the caller made into a proof: the policies only.
  docProofFor: [POLICY_DOC],
  workspaceProofFor: [POLICY_WORKSPACE],
  proveRenderDoc: [POLICY],
  // Identity: who is acting.
  proveSelf: [POLICY, POLICY_DOC, POLICY_WORKSPACE, MCP_AUTH, MCP_WRAPPER],
  proveAdmin: [POLICY],
  proveScimWorkspace: [POLICY, '^server/utils/sso/scim\\.ts$'],
  // A row the caller just inserted.
  proveNewDoc: CREATION,
  // Membership of a user, checked against the database.
  proveDocMembership: [MCP_WRAPPER, MCP_EXPORT_TOOL, ...AI_SESSION, ...AI_TOOLS, AI_JOBS, POLICY_PROVER, EXPLORER],
  proveDocNeed: [EXPLORER, IMPORT_ROUTE],
  proveFolderScope: [EXPLORER, IMPORTS, ...AI_TOOLS],
  proveScope: [EXPLORER, IMPORTS, ...AI_TOOLS],
  memberWorkspaceProofs: [EXPLORER, ...AI_TOOLS],
  // The import worker acts for the user who started the job.
  proveImportJobScope: [IMPORT_WORKER],
  proveWorkspaceAccess: [MCP_WRAPPER, ...AI_SESSION, ...AI_TOOLS, ...CREATION, POLICY_PROVER],
  // The second-object prover for a user id: the policies hand it out as `ctx.prove`.
  proverFor: [POLICY, POLICY_DOC]
}

/** @type {import('eslint').Rule.RuleModule} */
const proofEntryImports = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }],
    messages: {
      entry: '{{ name }} mints a capability proof from what its caller vouches for; only the callers in PROOF_ENTRY_CALLERS (scripts/lint/proofRules.mjs) may use it. Take the proof from the handler ctx or tool context instead.'
    }
  },
  create(context) {
    /** @type {Record<string, string[]>} */
    const callers = context.options[0] ?? PROOF_ENTRY_CALLERS
    const file = context.physicalFilename.replaceAll('\\', '/').slice(context.cwd.replaceAll('\\', '/').length + 1)
    if (new RegExp(ACCESS_LAYER).test(file)) return {}
    /** @param {string} name */
    const forbidden = name => Object.hasOwn(callers, name) && !(callers[name] ?? []).some(re => new RegExp(re).test(file))
    return {
      /** @param {any} node */
      ImportSpecifier(node) {
        const name = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
        if (forbidden(name)) context.report({ node, messageId: 'entry', data: { name } })
      },
      // Nitro auto-imports server/utils/**, so a call needs no import
      // statement: a reference to the name that no local declaration binds
      // (unresolved, or resolved to a configured auto-import global) is the
      // same use.
      /** @param {any} node */
      'Program:exit'(node) {
        const global = context.sourceCode.getScope(node)
        const refs = [...global.through]
        for (const variable of global.variables) {
          if (variable.defs.length === 0) refs.push(...variable.references)
        }
        for (const ref of refs) {
          const name = ref.identifier.name
          if (forbidden(name)) context.report({ node: ref.identifier, messageId: 'entry', data: { name } })
        }
      }
    }
  }
}

/** @type {import('eslint').ESLint.Plugin} */
export const proofRules = {
  rules: {
    'no-proof-forgery': noProofForgery,
    'proof-entry-imports': proofEntryImports
  }
}
