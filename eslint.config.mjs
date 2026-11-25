// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import sonarjs from 'eslint-plugin-sonarjs'
import security from 'eslint-plugin-security'
import a11y from 'eslint-plugin-vuejs-accessibility'
import vitest from '@vitest/eslint-plugin'
import playwright from 'eslint-plugin-playwright'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import { RAW_HANDLER_EXCEPTIONS } from './tests/unit/platform/apiRoutes.exceptions.ts'
import { proofRules, PROOF_ENTRY_CALLERS } from './scripts/lint/proofRules.mjs'

const ROOT = import.meta.dirname

// Recommended rule sets are taken at `error`. `strict` upgrades whichever
// severity a preset picked so the whole tree is uniform: no rule warns.
const strict = rules => Object.fromEntries(
  Object.entries(rules).map(([name, value]) => [
    name,
    Array.isArray(value) ? ['error', ...value.slice(1)] : (value === 'off' || value === 0 ? value : 'error')
  ])
)

// Lint modes (LINT_TYPES), selected by the package scripts:
//   all  (default) every rule, what `bun run lint` and CI run.
//   off  everything except the type-aware rules: no TypeScript project is
//        loaded, so it takes seconds instead of minutes (`lint:fast`).
//   only just the type-aware rules (`lint:types`).
// Type-aware rules cost ~95 % of the lint time (every call is resolved through
// the type checker), which is why they can be split out.
const LINT_TYPES = process.env.LINT_TYPES ?? 'all'
if (!['all', 'off', 'only'].includes(LINT_TYPES)) throw new Error(`LINT_TYPES must be all, off or only (got ${LINT_TYPES})`)

const TS_GLOBS = ['**/*.ts', '**/*.vue', '**/*.mts']
const TESTS = ['tests/**', 'sync-server/**/*.test.ts', 'sync-server/tests/**', 'renderer/**/*.test.ts']
const BACKEND = ['server/**', 'sync-server/src/**', 'renderer/src/**']

// Data-access boundaries (markoto/data-access-boundaries below).
const DB_IMPORTS = {
  group: ['drizzle-orm', 'drizzle-orm/*', 'pg', 'pg/*', '**/db/*', '~~/server/db/*', '#server/db/*'],
  message: 'Only server/repos talks to the database. Add or reuse a repo function.'
}
const MINT_IMPORTS = {
  group: ['**/repos/proofs/testing', '**/repos/proofs/mint', '**/repos/access/*'],
  message: 'Proofs are minted by the access layer (server/utils/access); import the proof types from server/repos/proofs.'
}

// Backend code logs through `useLogger` (docs/contributing/logging.md). The
// only console users: the boot-time configuration report of each process
// (a plain, human-readable problem list written before any logger setting is
// valid) and the nitropack entry copy, whose "Listening on" line is upstream's.
const CONSOLE_ALLOWED = [
  'server/plugins/01-validate-secrets.ts',
  'server/runtime/bunEntry.ts',
  'sync-server/src/env.ts',
  'renderer/src/env.ts'
]

// Milestone vocabulary (work-package, phase and batch labels) is planning jargon
// that means nothing to a reader of the open-source tree; comments and strings
// should say what the code does and why.
const MILESTONE_RE = /\b(WP ?\d+[a-z]?|Phase \d+|Batch \d+|[Ss]ecurity batch|Workstream [A-Z])\b/
const MESSAGE = 'Internal milestone vocabulary ({{ match }}); describe the behaviour or reason instead.'

// Configuration is read through the typed env registry (shared/env,
// docs/contributing/configuration.md), never `process.env` directly, a
// raw read bypasses boot validation, the documented default and the
// generated reference. `process.env.NODE_ENV` is a build-time constant
// to every bundler (`bun build` turns it into 'development' in the operator
// CLIs): server/ and shared/ ask `isProduction()` / `nodeEnv()`
// (shared/env/runtime.ts) instead; the sync server and the renderer run
// their TypeScript unbundled and may still read it. The files in
// RAW_ENV_ALLOWED are the env module itself and the few places that must
// see the raw record.
const RAW_ENV_ALLOWED = [
  'shared/env/**',
  // Copy of nitropack's bun preset entry (NITRO_* listen options), kept
  // byte-close to upstream (tests/unit/platform/bunEntryUpstream.test.ts).
  'server/runtime/bunEntry.ts',
  // Test-mode guard: decides whether required values are relaxed, so it
  // reads the raw record before the registry is parsed.
  'shared/utils/security/testMode.ts',
  // Boot validation hands the whole process environment to loadEnv.
  'server/plugins/01-validate-secrets.ts'
]
const RAW_ENV_MESSAGE = 'Read configuration through the typed env (useEnv() / syncEnv() / renderer env), not process.env, see docs/contributing/configuration.md.'
const NODE_ENV_MESSAGE = 'process.env.NODE_ENV is replaced at build time (bun build makes it \'development\' in the operator CLIs); use isProduction() / nodeEnv() from shared/env/runtime.ts.'

/** @type {import('eslint').ESLint.Plugin} */
const markoto = {
  rules: {
    ...proofRules.rules,
    'no-raw-env': {
      meta: {
        type: 'problem',
        schema: [{ type: 'object', properties: { allowNodeEnv: { type: 'boolean' } }, additionalProperties: false }],
        messages: { raw: RAW_ENV_MESSAGE, nodeEnv: NODE_ENV_MESSAGE }
      },
      create(context) {
        const allowNodeEnv = context.options[0]?.allowNodeEnv === true
        return {
          'MemberExpression[object.type="Identifier"][object.name="process"][property.name="env"]'(node) {
            const parent = node.parent
            const key = parent?.type === 'MemberExpression' && parent.object === node
              ? (parent.computed ? parent.property.value : parent.property.name)
              : undefined
            if (key === 'NODE_ENV') {
              if (!allowNodeEnv) context.report({ node, messageId: 'nodeEnv' })
              return
            }
            context.report({ node, messageId: 'raw' })
          }
        }
      }
    },
    'no-milestone-vocabulary': {
      meta: { type: 'suggestion', schema: [], messages: { milestone: MESSAGE } },
      create(context) {
        const check = (node, text) => {
          const m = MILESTONE_RE.exec(text)
          if (m) context.report({ node, messageId: 'milestone', data: { match: m[0] } })
        }
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const m = MILESTONE_RE.exec(comment.value)
              if (m) context.report({ loc: comment.loc, messageId: 'milestone', data: { match: m[0] } })
            }
          },
          Literal(node) { if (typeof node.value === 'string') check(node, node.value) },
          TemplateElement(node) { check(node, node.value.cooked ?? node.value.raw) }
        }
      }
    }
  }
}

// `tsconfig.json` at the root only holds project references (`files: []`), so
// typescript-eslint's project service finds nothing there; point it at the
// generated per-environment configs instead.
const NUXT_PROJECT_FILES = {
  app: ['app/**/*.{ts,vue}', 'i18n/**/*.ts'],
  server: ['server/**/*.ts'],
  shared: ['shared/**/*.ts'],
  node: ['modules/*.ts', 'nuxt.config.ts']
}
const NUXT_TYPE_AWARE_IGNORES = TESTS

const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/require-array-sort-compare': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error'
}

// Time-arithmetic literals duplicate the shared constants and drift.
const timeSelectors = [
  'BinaryExpression[operator="*"][left.value=60][right.value=60]',
  'BinaryExpression[operator="*"][left.value=24][right.value=60]',
  'BinaryExpression[operator="*"][left.value=60][right.value=1000]',
  'BinaryExpression[operator="*"][left.value=1000][right.value=60]',
  'BinaryExpression[operator="*"][left.value=7][right.value=24]'
].map(selector => ({ selector, message: 'Use the shared time constants instead of multiplying out a duration.' }))

// Error codes belong in one typed place so clients and tests can match them.
const createErrorCode = {
  selector: 'CallExpression[callee.name="createError"] > ObjectExpression > Property[key.name="data"] > ObjectExpression > Property[key.name="code"][value.type="Literal"]',
  message: 'Do not inline the error code string in createError; use the shared error-code helper.'
}

// The API handler contract (docs/contributing/api-handlers.md): a route is
// declared with `defineApiHandler`, reads its inputs through schemas, gets the
// session from its policy and refuses with `apiError`. These selectors are
// errors in every handler file except the raw exceptions
// (tests/unit/platform/apiRoutes.exceptions.ts).
const handlerSelectors = [
  {
    selector: 'ExportDefaultDeclaration > CallExpression[callee.name=/^(defineEventHandler|eventHandler|defineCachedEventHandler|defineLazyEventHandler)$/]',
    message: 'Declare the route with defineApiHandler({ access: allow.*(), ... }).'
  },
  {
    selector: 'CallExpression[callee.name=/^(readBody|readValidatedBody|getQuery|getValidatedQuery|getRouterParam|getRouterParams|requireRouteParam|requireDocId|requireWsId)$/]',
    message: 'Declare params / query / body as zod schemas on defineApiHandler and read them from the handler context.'
  },
  {
    selector: 'CallExpression[callee.name=/^(requireValidatedUserSession|getValidatedUserSession|requireRecentLogin|requireAdminUser|getUserSession)$/]',
    message: 'The access policy provides the user (ctx.user); use allow.user() / allow.admin() / recentLogin: true.'
  },
  { selector: 'CallExpression[callee.name="createError"]', message: 'Refuse with apiError(code, params): the code and its text live in the registry (shared/api/errors/).' }
]

// Client calls: route-keyed apiFetch types the response itself, and the
// error handler translates registered codes.
const apiClientSelectors = [
  { selector: 'CallExpression[callee.name="$fetch"][typeArguments]', message: 'Use apiFetch(\'/api/route/:param\', { path }), the response type comes from the route.' },
  { selector: 'MemberExpression[property.name="message"][object.property.name="data"]', message: 'Show API errors through useErrorHandler (translated by code), not the raw data.message.' }
]

// File paths in flat-config `files` are globs: escape the brackets of `[docId]`.
const literalPaths = paths => paths.map(p => p.replace(/[[\]]/g, '\\$&'))
const HANDLER_GLOBS = ['server/api/**/*.ts', 'server/routes/**/*.ts']

// Rules for stacks this project does not use (AWS IaC, React, Angular, jQuery,
// Cypress, ...) can only produce noise.
// eslint-disable-next-line sonarjs/regex-complexity -- a flat alternation of rule-name prefixes
const IRRELEVANT_SONAR = /^sonarjs\/(aws-|jsx-|no-uniq-key|no-useless-react|no-hook-setter|no-angular|prefer-native-jquery|prefer-cypress|prefer-native-axios|no-vue-class|no-vue-mixins|no-debounce-throttle|testing-library|no-forced-browser|no-debug-commands|no-networkidle|review-blockchain|xml-parser|web-sql|prefer-read-only-props|no-mutate-reactive|memoize-cache|avoid-mutating)/

const sonarRules = Object.fromEntries(
  Object.entries(strict(sonarjs.configs.recommended.rules))
    .map(([name, value]) => [name, IRRELEVANT_SONAR.test(name) ? 'off' : value])
)

const typeAwareBlocks = [
  // One block per generated Nuxt tsconfig: a file is checked against the one
  // program that owns it. Listing all four for every file makes the parser
  // hold every program at once, which does not fit a CI runner's memory.
  ...Object.entries(NUXT_PROJECT_FILES).map(([project, files]) => ({
    name: `markoto/type-aware-nuxt-${project}`,
    files,
    ignores: NUXT_TYPE_AWARE_IGNORES,
    languageOptions: {
      parserOptions: { project: [`.nuxt/tsconfig.${project}.json`], tsconfigRootDir: ROOT, extraFileExtensions: ['.vue'] }
    },
    rules: typeAwareRules
  })),
  ...['sync-server', 'renderer'].map(dir => ({
    name: `markoto/type-aware-${dir}`,
    files: [`${dir}/src/**/*.ts`],
    ignores: [`${dir}/**/*.test.ts`],
    languageOptions: {
      parserOptions: { project: [`${dir}/tsconfig.json`], tsconfigRootDir: ROOT }
    },
    rules: typeAwareRules
  })),
  {
    // A proof reaches a repo only as a value the access layer minted: no
    // type assertion to a proof type and no `any` / `never` value in a proof
    // slot. The proof module and the access layer are the minters.
    name: 'markoto/no-proof-forgery',
    files: ['server/**/*.ts'],
    ignores: [...TESTS, 'server/repos/proofs/**', 'server/utils/access/**'],
    plugins: { markoto },
    rules: { 'markoto/no-proof-forgery': 'error' }
  }
]

const composed = withNuxt(
  {
    // Galaxy collections / roles fetched into infra/collections/ ship JS
    // fixtures + sample policies that aren't ours to lint. Same for
    // infra/.ansible/ runtime cache.
    ignores: [
      'infra/collections/**',
      'infra/.ansible/**'
    ]
  },

  // --- Type-aware typescript-eslint --------------------------------------
  ...(LINT_TYPES === 'off' ? [] : typeAwareBlocks),
  {
    name: 'markoto/ts-syntax-rules',
    files: TS_GLOBS,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }]
    }
  },

  // --- SonarJS -------------------------------------------------------------
  {
    name: 'markoto/sonarjs',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    plugins: { sonarjs },
    rules: {
      ...sonarRules,
      'sonarjs/cognitive-complexity': ['error', 15],
      // Duplicates of rules already enforced by ESLint core / @nuxt/eslint /
      // typescript-eslint.
      'sonarjs/unused-import': 'off',
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/no-fallthrough': 'off',
      'sonarjs/no-labels': 'off',
      'sonarjs/no-empty-character-class': 'off',
      'sonarjs/no-invalid-regexp': 'off',
      'sonarjs/no-regex-spaces': 'off',
      'sonarjs/no-control-regex': 'off',
      'sonarjs/no-misleading-character-class': 'off',
      'sonarjs/no-useless-catch': 'off',
      'sonarjs/no-delete-var': 'off',
      'sonarjs/no-dead-store': 'off',
      'sonarjs/no-identical-conditions': 'off',
      'sonarjs/no-identical-expressions': 'off',
      'sonarjs/no-duplicated-branches': 'off',
      'sonarjs/no-redundant-optional': 'off',
      'sonarjs/redundant-type-aliases': 'off',
      'sonarjs/no-array-delete': 'off',
      'sonarjs/prefer-regexp-exec': 'off',
      'sonarjs/no-primitive-wrappers': 'off',
      'sonarjs/no-global-this': 'off',
      'sonarjs/no-implicit-global': 'off',
      'sonarjs/block-scoped-var': 'off',
      'sonarjs/updated-const-var': 'off',
      'sonarjs/no-ignored-exceptions': 'off',
      // `@typescript-eslint/no-explicit-any` covers the type side.
      'sonarjs/use-type-alias': 'off',
      // Style noise / a ban the project does not want.
      'sonarjs/fixme-tag': 'off',
      'sonarjs/todo-tag': 'off',
      'sonarjs/class-name': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-functions': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/prefer-immediate-return': 'off',
      'sonarjs/no-small-switch': 'off',
      'sonarjs/function-return-type': 'off',
      'sonarjs/no-selector-parameter': 'off',
      'sonarjs/bitwise-operators': 'off',
      'sonarjs/void-use': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'sonarjs/no-wildcard-import': 'off',
      'sonarjs/concise-regex': 'off',
      'sonarjs/single-char-in-character-classes': 'off',
      'sonarjs/single-character-alternation': 'off',
      'sonarjs/prefer-native-lodash-alternative': 'off',
      'sonarjs/no-default-utility-imports': 'off',
      // Takes ~95% of the lint time on Vue SFCs (it resolves every call's
      // declaration through the type checker).
      'sonarjs/deprecation': 'off',
      // ~60% of total lint time (type-checker promise analysis) and it
      // overlaps no-floating-promises / no-misused-promises.
      'sonarjs/no-try-promise': 'off'
    }
  },

  // --- Size limits ---------------------------------------------------------
  {
    name: 'markoto/size-limits',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    name: 'markoto/size-limits-exempt',
    // Data-only modules, generated output and vendored files are long by nature.
    files: ['shared/utils/theme/themePresets.ts', 'drizzle/**', 'public/**', 'infra/**', 'i18n/**', '.nuxt/**'],
    rules: { 'max-lines': 'off', 'max-lines-per-function': 'off' }
  },

  // --- Logging -------------------------------------------------------------
  {
    name: 'markoto/no-console-backend',
    files: BACKEND.map(g => `${g}/*.{ts,mts,js,mjs}`).concat(BACKEND.map(g => `${g}/**/*.{ts,mts,js,mjs}`)),
    ignores: [...TESTS, ...CONSOLE_ALLOWED],
    rules: { 'no-console': 'error' }
  },

  // --- Security ------------------------------------------------------------
  {
    ...security.configs.recommended,
    name: 'markoto/security',
    files: BACKEND.map(g => `${g}/**/*.{ts,mts,js,mjs}`),
    ignores: TESTS,
    rules: {
      ...strict(security.configs.recommended.rules),
      // Fires on every `obj[key]`; far too noisy to act on.
      'security/detect-object-injection': 'off'
    }
  },

  // Only server/repos talks to the database, and proofs are minted only by
  // the access layer (docs/SECURITY-HARDENING.md, tenancy). dependency-cruiser
  // enforces the same boundaries on the resolved graph; this rule flags them
  // in the editor. Later blocks replace the rule's options, so each repeats
  // the patterns it keeps.
  {
    name: 'markoto/data-access-boundaries',
    files: ['app/**/*.{ts,vue}', 'server/**/*.{ts,mts}', 'shared/**/*.ts', 'modules/**/*.ts'],
    ignores: ['server/db/**', 'server/repos/**', 'shared/utils/runtime/postgresSsl.ts', ...TESTS],
    rules: { 'no-restricted-imports': ['error', { patterns: [DB_IMPORTS, MINT_IMPORTS] }] }
  },
  {
    name: 'markoto/no-system-actor-in-handlers',
    // A user-facing handler acts with the caller's proofs from its policy; a
    // named system actor would act on anything. Internal, webhook and
    // test-only routes are the exceptions (they have no user).
    files: ['server/api/**/*.ts'],
    ignores: ['server/api/internal/**', 'server/api/_test/**', 'server/api/webhooks/**', ...TESTS],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [DB_IMPORTS, MINT_IMPORTS, {
          group: ['**/repos/proofs', '**/repos/proofs/index'],
          importNames: ['system'],
          message: 'User-facing handlers act with the proofs their policy hands them, not a system actor.'
        }]
      }]
    }
  },
  {
    name: 'markoto/access-layer-imports',
    // The access layer itself mints proofs and reads the authorization bootstrap rows.
    files: ['server/utils/access/**/*.ts', 'server/utils/mcp/mcpAuth.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [DB_IMPORTS, { group: ['**/repos/proofs/testing'], message: 'The test mint is for tests only.' }]
      }]
    }
  },

  {
    name: 'markoto/proof-entry-imports',
    // The access-layer functions that mint a proof from a user id or a
    // decision the caller made, used only by their listed callers (imported
    // or auto-imported). Server code never silences the compiler with a
    // ts-comment: that would be a way past the proof types too.
    files: ['server/**/*.ts'],
    ignores: TESTS,
    plugins: { markoto },
    rules: {
      'markoto/proof-entry-imports': ['error', PROOF_ENTRY_CALLERS],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true }]
    }
  },

  // --- Configuration -------------------------------------------------------
  {
    name: 'markoto/no-raw-env',
    files: ['server/**', 'shared/**'].map(g => `${g}/*.{ts,mts,js,mjs}`),
    ignores: [...TESTS, ...RAW_ENV_ALLOWED],
    plugins: { markoto },
    rules: { 'markoto/no-raw-env': 'error' }
  },
  {
    name: 'markoto/no-raw-env-services',
    files: ['sync-server/src/**', 'renderer/src/**'].map(g => `${g}/*.{ts,mts,js,mjs}`),
    ignores: [...TESTS, ...RAW_ENV_ALLOWED],
    plugins: { markoto },
    rules: { 'markoto/no-raw-env': ['error', { allowNodeEnv: true }] }
  },

  // --- Restricted syntax + milestone vocabulary ---------------------------
  {
    name: 'markoto/restricted-syntax',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: ['shared/config/**', ...TESTS],
    rules: { 'no-restricted-syntax': ['error', ...timeSelectors, createErrorCode] }
  },
  // Later blocks replace the rule's options instead of merging them, so each
  // re-spreads the general selectors.
  {
    name: 'markoto/api-handlers',
    files: HANDLER_GLOBS,
    ignores: literalPaths(Object.keys(RAW_HANDLER_EXCEPTIONS)),
    rules: { 'no-restricted-syntax': ['error', ...timeSelectors, createErrorCode, ...handlerSelectors] }
  },
  {
    name: 'markoto/api-client',
    files: ['app/**/*.{ts,vue}'],
    rules: { 'no-restricted-syntax': ['error', ...timeSelectors, createErrorCode, ...apiClientSelectors] }
  },
  {
    name: 'markoto/milestone-vocabulary',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: ['infra/**', '.nuxt/**', 'drizzle/**'],
    plugins: { markoto },
    rules: { 'markoto/no-milestone-vocabulary': 'error' }
  },

  // --- Vue accessibility ---------------------------------------------------
  ...a11y.configs['flat/recommended'].map(c => ({
    ...c,
    files: ['app/**/*.vue'],
    ...(c.rules ? { rules: strict(c.rules) } : {})
  })),
  {
    name: 'markoto/a11y-label-has-for',
    files: ['app/**/*.vue'],
    rules: {
      // A label is associated by `for`/`id` OR by wrapping its control. Nuxt UI
      // inputs render the native control themselves, so they count as controls.
      'vuejs-accessibility/label-has-for': ['error', {
        required: { some: ['nesting', 'id'] },
        controlComponents: ['UInput', 'UTextarea', 'USelect', 'USelectMenu', 'UInputMenu', 'UInputNumber', 'UCheckbox', 'URadioGroup', 'USwitch', 'USlider', 'UPinInput']
      }]
    }
  },

  // --- vue-i18n ------------------------------------------------------------
  ...vueI18n.configs['flat/base'],
  {
    name: 'markoto/vue-i18n',
    files: ['app/**/*.{vue,ts}'],
    ignores: ['app/pages/admin/**', 'app/pages/docs/_internal/**'],
    settings: {
      'vue-i18n': {
        localeDir: { pattern: './i18n/locales/*.json', localeKey: 'file' },
        messageSyntaxVersion: '^11.0.0'
      }
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': ['error', {
        attributes: { '/.+/': ['placeholder', 'title', 'aria-label', 'label', 'alt'] },
        // Not translatable text: strings without a single letter (symbols,
        // arrows, digits, and the empty `alt=""` of decorative images), URL
        // paths shown as eyebrows ("/settings/ai") and example web addresses.
        ignorePattern: '^([^A-Za-z\\u00C0-\\u024F\\u3040-\\u9FFF]*|/[\\w/ ·-]*|https?://\\S+)$',
        ignoreText: [
          // Product and brand names, plan names (kept literal on the pricing page too).
          'markoto', 'markoto.app', 'GitHub', 'Pro', 'Team', 'Business',
          // Keyboard keys and heading level marks.
          'Esc', 'esc', '⌘K', 'H1', 'H2', 'H3',
          // Format, DNS and protocol names, "v" in a version number ("v3"), a font specimen.
          'CSV', 'JSON Lines', 'TXT', 'CNAME', 'v', 'Aa',
          // Placeholder examples of values the user types.
          'example.com', '-----BEGIN CERTIFICATE-----', 'claude_desktop_config.json'
        ]
      }],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      '@intlify/vue-i18n/no-unused-keys': ['error', { src: './app', extensions: ['.vue', '.ts'] }]
    }
  },
  {
    name: 'markoto/vue-i18n-locales',
    files: ['i18n/locales/*.json'],
    settings: {
      'vue-i18n': { localeDir: './i18n/locales/*.json', messageSyntaxVersion: '^11.0.0' }
    },
    rules: { '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error' }
  },

  {
    name: 'markoto/scripts-and-locales',
    files: ['scripts/**'],
    rules: { 'sonarjs/no-os-command-from-path': 'off' }
  },
  {
    // The content database lives on the container's own tmpfs (the app image
    // runs read-only with a private /tmp), not a shared world-writable dir;
    // see the comment next to it in nuxt.config.ts.
    name: 'markoto/nuxt-config-tmp',
    files: ['nuxt.config.ts'],
    rules: { 'sonarjs/publicly-writable-directories': 'off' }
  },
  {
    // French typography uses non-breaking spaces before : ; ! ? on purpose.
    name: 'markoto/locale-json-whitespace',
    files: ['i18n/locales/*.json'],
    rules: { 'no-irregular-whitespace': 'off' }
  },

  // --- Tests ---------------------------------------------------------------
  {
    ...vitest.configs.recommended,
    name: 'markoto/vitest',
    files: ['tests/{unit,dom,nuxt,repos,integration}/**/*.{ts,mts}', 'sync-server/**/*.test.ts', 'renderer/**/*.test.ts'],
    rules: {
      ...strict(vitest.configs.recommended.rules),
      // `expect(value, 'message')` is valid Vitest API.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // Helpers named `expectSomething(...)` hold the assertions of many tests.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }]
    }
  },
  {
    ...playwright.configs['flat/recommended'],
    name: 'markoto/playwright',
    files: ['tests/e2e/**/*.ts', 'tests/smoke/**/*.ts'],
    rules: strict(playwright.configs['flat/recommended'].rules)
  },
  {
    name: 'markoto/tests-loosened',
    files: ['tests/**', 'sync-server/**/*.test.ts', 'sync-server/tests/**', 'renderer/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/cognitive-complexity': 'off',
      // Fixtures are full of loopback / http:// URLs, literal IPs, fake
      // secrets and Math.random ids; none of it ships.
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/regex-complexity': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/prefer-specific-assertions': 'off',
      'sonarjs/code-eval': 'off',
      'sonarjs/publicly-writable-directories': 'off',
      'sonarjs/no-nested-functions': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      // Tests shell out to docker / git / bun by name, use `static` helpers
      // freely and write explicit cases instead of `it.each` tables.
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/public-static-readonly': 'off',
      'sonarjs/parameterized-tests': 'off'
    }
  },
  {
    // Browser specs skip on purpose (live-AI suites without a key, mobile vs
    // desktop) and assert through page helpers / `expect.poll`.
    name: 'markoto/e2e-skips',
    files: ['tests/e2e/**/*.ts', 'tests/smoke/**/*.ts'],
    rules: {
      'playwright/no-skipped-test': ['error', { allowConditional: true }],
      'sonarjs/no-skipped-tests': 'off',
      'sonarjs/assertions-in-tests': 'off'
    }
  },
  {
    // One spec per flow that branches on mobile vs desktop is the convention
    // (tests/e2e/AGENTS.md), so conditionals inside a flow are intended.
    name: 'markoto/e2e-flows',
    files: ['tests/e2e/flows/**/*.ts'],
    rules: {
      'playwright/no-conditional-in-test': 'off',
      'playwright/no-conditional-expect': 'off'
    }
  },
  {
    // Screenshot / video capture scripts that happen to use the Playwright
    // runner; they are not tests.
    name: 'markoto/e2e-tour',
    files: ['tests/e2e/tour/**/*.ts'],
    rules: Object.fromEntries(Object.keys(playwright.configs['flat/recommended'].rules).map(name => [name, 'off']))
  }
)

// `lint:types` keeps only the type-aware rules. Plugins and parsers stay
// registered (rule configs of other blocks are just emptied), and unused
// disable directives are not reported because the rules they name are off.
// `onResolved` / `append` queue onto the composer and return it (it is a
// thenable); `export default composed` is where ESLint awaits it, so the
// returned value is dropped on purpose (`void`).
if (LINT_TYPES === 'only') {
  const typeAwareNames = new Set([...Object.keys(typeAwareRules), 'markoto/no-proof-forgery'])
  void composed.onResolved((configs) => {
    for (const config of configs) {
      if (!config.rules) continue
      config.rules = Object.fromEntries(Object.entries(config.rules).filter(([name]) => typeAwareNames.has(name)))
    }
    configs.push({ name: 'markoto/lint-types-only', linterOptions: { reportUnusedDisableDirectives: 'off' } })
    return configs
  })
}
if (LINT_TYPES === 'off') {
  void composed.append({ name: 'markoto/lint-fast', linterOptions: { reportUnusedDisableDirectives: 'off' } })
}

export default composed
