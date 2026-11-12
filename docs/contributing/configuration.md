# Configuration (environment variables)

Every environment variable markoto reads or passes is declared once, in the registry under `shared/env/`. Everything else is derived from it:

- the typed object each process reads its configuration from,
- boot validation of the app, the sync server and the renderer,
- `.env.example`, the [configuration reference](../reference/configuration.md) and its machine-readable twin `docs/reference/configuration.json`,
- the drift tests that hold the compose files and the deploy paths to the registry (`tests/unit/env/drift.test.ts`).

## Layout

| File | What it holds |
|---|---|
| `shared/env/coerce.ts` | The parsers: `bool` (one dialect: `1/true/yes/on`, `0/false/no/off`, any case), `int`, `positiveInt`, `nonNegativeInt`, `port`, `number`, `positiveNumber`, `bytes`, `durationMs`, `url(schemes)`, `hostname`, `email`, `pattern`, `csv(item)`, `oneOf`, `secret(minLength)`, `limitOrUnlimited`. No imports: the generator copies it into the renderer. |
| `shared/env/define.ts` | `v()` (one variable), `defineNamespace()`, the `Service` / `Scope` / `Rule` types. |
| `shared/env/vars/*.ts` | The variables, grouped into namespaces (`core`, `auth`, `database`, `storage`, `litellm`, `billing`, `tiers`, `publish`, …). |
| `shared/env/rules/*.ts` | Cross-field rules (OAuth pairs, OIDC trio, billing → Stripe keys, hosted shape → legal identity, BYOK allowlist, pages host, ALTCHA key). |
| `shared/env/namespaces.ts`, `registry.ts` | The namespace list and the typed env (`AppEnv`, `SyncEnv`); the rules. |
| `shared/env/load.ts` | `loadEnv(service)` (boot) and the runtime accessors `useEnv()` / `runtimeEnv(service)`. |

## Add a variable

1. Add one `v({...})` entry to the namespace it belongs to in `shared/env/vars/`:

   ```ts
   importMaxPages: v({
     name: 'NUXT_IMPORT_MAX_PAGES',   // what the operator sets
     type: positiveInt,               // a parser from coerce.ts
     default: 500,
     doc: 'Largest PDF (in pages) an import converts.',
     services: ['app'],               // who reads it: app / sync / renderer / litellm / markitdown / backup / compose / build
     scope: 'both'                    // self-host / hosted / both / dev / test
   }),
   ```

   Optional fields: `required` (`'always'`, `'production'`, or `{ when }` documenting a rule), `secret` (never printed, empty in `.env.example`), `aliases` (the name another container reads the same value under, e.g. `{ sync: 'JWT_SECRET' }`), `emptyIsValue`, `example` (uncommented in `.env.example`), `notPassed` (the compose files deliberately don't pass it, say why), `internal` (set by compose, not an operator setting), `deprecatedNames`.
2. Pass it in the compose file(s) of the shapes in `scope` (or set `notPassed`). For the app in `deploy/compose/compose.prod.yml` and `compose.selfhost.yml` a plain `${NAME}` passthrough is generated between the `# BEGIN env:gen app` markers by step 4 (`scripts/lib/composeEnv.ts`: `${NAME:?…}` in prod for a variable required at boot, else `${NAME:-}`); write a line by hand below the markers only for another value (a default, a derived URL, a pinned value). Then add it to `infra/render-env.sh` (its `INPUTS` list and the output) when the hosted deploy must set it, both hosted deploy paths run that script.
3. Read it: `useEnv().<namespace>.<key>` in the app, `syncEnv()` in the sync server, `env` from `renderer/src/env.ts` in the renderer. The value is already typed and defaulted.
4. Run `bun run env:gen` (writes `.env.example`, the reference, the renderer loader and the generated compose regions) and `bun run test:unit tests/unit/env`.

A value that two variables must agree on, or that is only required in some shape, is a rule in `shared/env/rules/`: return one message per problem, naming the real variable(s). Mark presence rules `relaxedInTestMode`, advisory ones `warning`.

## Reading configuration

- **Never `process.env`** in `server/`, `shared/`, `sync-server/src/` or `renderer/src/` (ESLint `markoto/no-raw-env`). `process.env.NODE_ENV` stays allowed (bundlers replace it). The allowlist in `eslint.config.mjs` is the env module itself, the generated renderer loader, the nitropack entry copy `server/runtime/bunEntry.ts`, the test-mode guard and the boot plugin.
- `runtimeConfig` keeps only what Nuxt modules and the browser read: `session` and `oauth` (nuxt-auth-utils) and `public`. Nuxt fills them from `NUXT_*`; `tests/unit/env/runtimeConfig.test.ts` checks every such name is registered.
- Pure helpers that take an env-shaped record (`resolveInstanceConfig(source)`, `resolveTiersFromEnv(source)`) parse it with the same registry: `useEnv(source)`.

## Validation

- **Boot.** `server/plugins/01-validate-secrets.ts` (app), `sync-server/src/boot-env.ts` and `renderer/src/env.ts` parse every variable of their process and run the rules. Any problem stops the process with one line per problem, never a value:

  ```
  Invalid configuration of the app (Nuxt) (2 problems):
    - NUXT_JWT_SECRET: expected at least 32 characters (got 9)
    - NUXT_SITE_INDEXABLE: expected a boolean (true/false, 1/0, yes/no, on/off)
  Every variable is described in docs/reference/configuration.md.
  ```

- **Build.** `nuxt build` (prerender) skips validation: images are built without a runtime environment.
- **Test mode** (`TEST_MODE=1` on a non-deployment) relaxes required values and presence rules, never types.
- **Runtime reads** parse with the same parsers, so a value that passed boot can't fail later; they don't re-check required values or rules.

Invalid values fail boot instead of silently falling back to the default. Unset or empty keeps the default.

## The renderer

The renderer image is built from the repository root with `shared/` copied next to `renderer/`, so `renderer/src/env.ts` calls `loadEnv('renderer')` like the sync server calls `loadEnv('sync')`.

## Tests

Tests hand configuration to the code under test the way an operator does: `vi.stubEnv('NUXT_X', '…')` or `stubEnv({...})` from `tests/helpers/env.ts`. See [testing.md](testing.md#configuration-in-tests).
