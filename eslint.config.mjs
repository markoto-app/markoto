// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import sonarjs from 'eslint-plugin-sonarjs'
import security from 'eslint-plugin-security'
import a11y from 'eslint-plugin-vuejs-accessibility'
import vitest from '@vitest/eslint-plugin'
import playwright from 'eslint-plugin-playwright'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'

const ROOT = import.meta.dirname

// Every lint rule added alongside the original Nuxt preset starts at `warn`:
// a recommended set may ship rules at `error`, and the backlog is burned down
// before anything blocks CI. `warnAll` downgrades whichever severity a preset
// picked so the rollout is uniform.
const warnAll = rules => Object.fromEntries(
  Object.entries(rules).map(([name, value]) => [
    name,
    Array.isArray(value) ? ['warn', ...value.slice(1)] : (value === 'off' || value === 0 ? value : 'warn')
  ])
)

const TS_GLOBS = ['**/*.ts', '**/*.vue', '**/*.mts']
const TESTS = ['tests/**', 'sync-server/**/*.test.ts', 'sync-server/tests/**', 'renderer/**/*.test.ts']
const BACKEND = ['server/**', 'sync-server/src/**', 'renderer/src/**']

// Milestone vocabulary (work-package, phase and batch labels) is planning jargon
// that means nothing to a reader of the open-source tree; comments and strings
// should say what the code does and why.
const MILESTONE_RE = /\b(WP ?\d+[a-z]?|Phase \d+|Batch \d+|[Ss]ecurity batch|Workstream [A-Z])\b/
const MESSAGE = 'Internal milestone vocabulary ({{ match }}); describe the behaviour or reason instead.'

/** @type {import('eslint').ESLint.Plugin} */
const markoto = {
  rules: {
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
const nuxtProjects = ['app', 'server', 'shared', 'node'].map(n => `.nuxt/tsconfig.${n}.json`)

const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': 'warn',
  '@typescript-eslint/await-thenable': 'warn',
  '@typescript-eslint/require-array-sort-compare': 'warn',
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/switch-exhaustiveness-check': 'warn'
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

// Rules for stacks this project does not use (AWS IaC, React, Angular, jQuery,
// Cypress, ...) can only produce noise.
// eslint-disable-next-line sonarjs/regex-complexity -- a flat alternation of rule-name prefixes
const IRRELEVANT_SONAR = /^sonarjs\/(aws-|jsx-|no-uniq-key|no-useless-react|no-hook-setter|no-angular|prefer-native-jquery|prefer-cypress|prefer-native-axios|no-vue-class|no-vue-mixins|no-debounce-throttle|testing-library|no-forced-browser|no-debug-commands|no-networkidle|review-blockchain|xml-parser|web-sql|prefer-read-only-props|no-mutate-reactive|memoize-cache|avoid-mutating)/

const sonarRules = Object.fromEntries(
  Object.entries(warnAll(sonarjs.configs.recommended.rules))
    .map(([name, value]) => [name, IRRELEVANT_SONAR.test(name) ? 'off' : value])
)

export default withNuxt(
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
  {
    name: 'markoto/type-aware-nuxt',
    files: TS_GLOBS,
    ignores: [...TESTS, 'scripts/**', 'sync-server/**', 'renderer/**', 'infra/**', '*.config.*', 'drizzle.config.ts', 'content.config.ts', 'playwright*.ts'],
    languageOptions: {
      parserOptions: { project: nuxtProjects, tsconfigRootDir: ROOT, extraFileExtensions: ['.vue'] }
    },
    rules: typeAwareRules
  },
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
    name: 'markoto/ts-syntax-rules',
    files: TS_GLOBS,
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }]
    }
  },

  // --- SonarJS -------------------------------------------------------------
  {
    name: 'markoto/sonarjs',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    plugins: { sonarjs },
    rules: {
      ...sonarRules,
      'sonarjs/cognitive-complexity': ['warn', 15],
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
      'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }]
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
    ignores: TESTS,
    rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] }
  },

  // --- Security ------------------------------------------------------------
  {
    ...security.configs.recommended,
    name: 'markoto/security',
    files: BACKEND.map(g => `${g}/**/*.{ts,mts,js,mjs}`),
    ignores: TESTS,
    rules: {
      ...warnAll(security.configs.recommended.rules),
      // Fires on every `obj[key]`; far too noisy to act on.
      'security/detect-object-injection': 'off'
    }
  },

  // --- Restricted syntax + milestone vocabulary ---------------------------
  {
    name: 'markoto/restricted-syntax',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: ['shared/config/**', ...TESTS],
    rules: { 'no-restricted-syntax': ['warn', ...timeSelectors, createErrorCode] }
  },
  {
    name: 'markoto/milestone-vocabulary',
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: ['infra/**', '.nuxt/**', 'drizzle/**'],
    plugins: { markoto },
    rules: { 'markoto/no-milestone-vocabulary': 'warn' }
  },

  // --- Vue accessibility ---------------------------------------------------
  ...a11y.configs['flat/recommended'].map(c => ({
    ...c,
    files: ['app/**/*.vue'],
    ...(c.rules ? { rules: warnAll(c.rules) } : {})
  })),

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
      '@intlify/vue-i18n/no-raw-text': ['warn', {
        attributes: { '/.+/': ['placeholder', 'title', 'aria-label', 'label', 'alt'] },
        // Strings without a single letter (symbols, arrows, digits) are not translatable text.
        ignorePattern: '^[^A-Za-z\\u00C0-\\u024F\\u3040-\\u9FFF]+$'
      }],
      '@intlify/vue-i18n/no-missing-keys': 'warn',
      '@intlify/vue-i18n/no-unused-keys': ['warn', { src: './app', extensions: ['.vue', '.ts'] }]
    }
  },
  {
    name: 'markoto/vue-i18n-locales',
    files: ['i18n/locales/*.json'],
    settings: {
      'vue-i18n': { localeDir: './i18n/locales/*.json', messageSyntaxVersion: '^11.0.0' }
    },
    rules: { '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'warn' }
  },

  {
    name: 'markoto/scripts-and-locales',
    files: ['scripts/**'],
    rules: { 'sonarjs/no-os-command-from-path': 'off' }
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
      ...warnAll(vitest.configs.recommended.rules),
      // `expect(value, 'message')` is valid Vitest API.
      'vitest/valid-expect': ['warn', { maxArgs: 2 }]
    }
  },
  {
    ...playwright.configs['flat/recommended'],
    name: 'markoto/playwright',
    files: ['tests/e2e/**/*.ts', 'tests/smoke/**/*.ts'],
    rules: warnAll(playwright.configs['flat/recommended'].rules)
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
      'security/detect-non-literal-fs-filename': 'off'
    }
  }
)
