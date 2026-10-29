# Workspace and Toolchain: RD-01 Foundation

> **Document**: 03-01-workspace-toolchain.md
> **Parent**: [Index](00-index.md)

## Overview

This component defines the pnpm workspace, package boundaries, TypeScript 7 configuration,
Biome setup, exact dependency policy, and verification scripts. It creates only the packages
needed by RD-01; `apps/agent` and `apps/cli` are created by RD-10 and RD-11 (P-13).

## Architecture

### Package graph

```text
apps/server ──▶ packages/api-contract ──▶ packages/core
apps/web    ──▶ packages/api-contract (later)
packages/test-support (dev-only; source-only)
```

- `packages/core` stays dependency-free and I/O-free.
- `packages/api-contract` owns Zod schemas and shared wire types.
- `packages/test-support` is source-only, dev-only, and never imported by production code.
- `apps/server` depends on `@openvault/core` and `@openvault/api-contract`.
- `apps/web` remains the UI shell; it does not consume the schema until RD-12.

### Package manifests

| Package | Production deps | Dev deps | Exports |
|---|---|---|---|
| `@openvault/core` | none | TypeScript, Vitest, `@types/node` | `dist/index.js`, `dist/index.d.ts` |
| `@openvault/api-contract` | `zod` exact, `@openvault/core` workspace | TypeScript, Vitest | `dist/index.js`, `dist/index.d.ts` |
| `@openvault/test-support` | none | TypeScript, Vitest | `src/index.ts` (source-only) |
| `@openvault/server` | BlendSDK, express, pg, zod, pino, exact | Vitest, supertest, tsx | `dist/main.js` |
| `@openvault/web` | React, Fluent UI, BlendSDK exact | Vite, Vitest, Testing Library | `dist/` |

### Root scripts

| Script | Command |
|---|---|
| `build` | `pnpm -r --if-present build` |
| `typecheck` | `pnpm -r --if-present typecheck` |
| `lint` | `biome check .` |
| `format` | `biome check --write .` |
| `test:unit` | `pnpm -r test` |
| `test:root` | `vitest run --config vitest.root.config.ts` |
| `test` | `pnpm test:unit && pnpm test:root` |
| `test:integration` | `pnpm --filter @openvault/server test:integration` |
| `check:artifacts` | `node scripts/check-artifacts.mjs` |
| `check:react` | `node scripts/check-single-react.mjs` |
| `verify` | `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check:artifacts && pnpm check:react && pnpm docs:build` |
| `audit:prod` | `pnpm audit --prod --audit-level=high` |
| `audit:full` | `pnpm audit --audit-level=high` |
| `db:migrate` | `pnpm --filter @openvault/server db:migrate` |

`verify` builds first so workspace packages resolve through their `dist` exports. pnpm's
topological ordering builds `core`, then `api-contract`, then `server`. `typecheck` after the
build still validates test sources. `verify` never runs database integration tests; those run
only through `test:integration` with a real PostgreSQL service.

### Package scripts

`apps/server`:

```json
{
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.test.json",
    "test": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "db:migrate": "node dist/db/cli.js"
  }
}
```

`packages/api-contract`:

```json
{
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.test.json",
    "test": "vitest run"
  }
}
```

`packages/test-support`:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.test.json",
    "test": "vitest run"
  }
}
```

`packages/test-support/tests/sentinels.spec.test.ts` asserts the sentinel exports, so the
package has at least one test and `test:unit` cannot fail with “No test files found”.

`packages/core` and `apps/web` keep equivalent `build`, `typecheck`, and `test` scripts.
`test:unit` uses `pnpm -r test`. Every package in RD-01 declares a `test` script; a root test
asserts that each workspace package has one, so a missing script is a test failure rather than
a silent skip.

`vitest.config.ts` includes `tests/**/*.test.ts` but excludes `tests/integration/**`.
`vitest.integration.config.ts` includes `tests/integration/**/*.test.ts` with `maxWorkers: 1`
and `environment: "node"`.

### Dependency policy

- Every production dependency is exact-pinned; no `^` or `~`.
- Dev dependencies are exact-pinned except `@types/node`, which is lockfile-resolved.
- `pnpm install --frozen-lockfile` is the only install used in CI.
- `@openvault/*` dependencies use `workspace:*`.
- `pnpm.overrides` pins `react` and `react-dom` to the single installed version.
- `scripts/check-single-react.mjs` checks `pnpm -r list react` and
  `pnpm -r list @griffel/react` and fails on duplicate versions.
- `pnpm-workspace.yaml` carries `dedupePeerDependents: true` and
  `strictPeerDependencies: true`; `.npmrc` carries only registry/auth settings.

### TypeScript 7

- `tsconfig.base.json`: ES2022, strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `sourceMap: false`,
  `declarationMap: false`.
- Server/core: `module: NodeNext`, `moduleResolution: NodeNext`, explicit `types: ["node"]`.
- API contract: same as core.
- UI: `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`,
  `skipLibCheck: true`.
- Each built package has a build tsconfig and a test tsconfig with `noEmit`.
- `packages/test-support` is source-only; Vitest transpiles it. It has no build output and is
  excluded from the artifact check.

### Biome

- `biome check .` is the lint gate.
- Markdown formatting is disabled; `.opencode` and generated output are excluded.
- Recommended rules; no type-aware lint (TypeScript 7 is not supported by typescript-eslint).

### Test layout

- Unit tests: `tests/**/*.test.ts`, `tests/**/*.test.tsx`, or `src/**/*.test.ts`.
- Integration tests: `apps/server/tests/integration/**/*.test.ts`, run by the integration
  config only.
- Root policy tests: `tests/*.spec.test.mjs` under the root Vitest config.
- The web package keeps `jsdom`; server/core use `node`.
- No test uses a real secret; `packages/test-support` exports the sentinel.

## Implementation Details

### New types and interfaces

```ts
// packages/core/src/ids.ts
export type Ulid = string;
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function isUlid(value: unknown): value is Ulid;
```

```ts
// packages/core/src/names.ts
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/;
```

```ts
// packages/api-contract/src/ids.ts
import { z } from "zod";
import { ULID_PATTERN, PROJECT_NAME_PATTERN, SECRET_NAME_PATTERN } from "@openvault/core";

export const ulidSchema = z.string().regex(ULID_PATTERN);
export const projectNameSchema = z.string().regex(PROJECT_NAME_PATTERN);
export const secretNameSchema = z.string().regex(SECRET_NAME_PATTERN);
```

```ts
// packages/test-support/src/sentinels.ts
export const SENTINEL_VALUE = "SENTINEL_DO_NOT_LEAK_7f3a";
export const SENTINEL_KEY = "SENTINEL_KEY_DO_NOT_LEAK_7f3a";
```

### Error handling

| Error case | Handling | AR Ref |
|---|---|---|
| Missing workspace package | `pnpm install` fails; CI blocks | P-03 |
| Duplicate React or Griffel | `check-single-react` exits 1 with paths | P-06 |
| Build/typecheck failure | `verify` stops before tests | P-05 |
| Integration DB unavailable | `test:integration` fails with a setup message | P-01, P-07, P-15 |
| Stale `dist` | build script deletes `dist` first | P-08 |

### Code examples

```json
{
  "scripts": {
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck",
    "test:unit": "pnpm -r test",
    "test:root": "vitest run --config vitest.root.config.ts",
    "test": "pnpm test:unit && pnpm test:root",
    "test:integration": "pnpm --filter @openvault/server test:integration",
    "check:artifacts": "node scripts/check-artifacts.mjs",
    "check:react": "node scripts/check-single-react.mjs",
    "verify": "pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check:artifacts && pnpm check:react && pnpm docs:build"
  }
}
```

## Integration Points

- `apps/server` consumes `api-contract` and `core`.
- `packages/test-support` is a devDependency of packages whose tests need sentinels.
- RD-02 consumes the config types; RD-05/06 consume IDs and names.
- RD-14 verifies the duplicate React/Griffel and artifact checks.

## Testing Requirements

- Unit test `isUlid`, project/secret name regexes, and invalid inputs.
- Unit test the single-React check against a nested fixture with two React versions.
- Root test that `packages/core/package.json` has no `dependencies`.
- Root test that `verify` contains the artifact and React checks in the documented order.
- Test that the server unit config excludes `tests/integration/**`.
- Test that `test:root` is included in `verify`.
