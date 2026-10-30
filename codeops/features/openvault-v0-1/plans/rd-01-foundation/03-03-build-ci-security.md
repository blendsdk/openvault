# Build and CI Security: RD-01 Foundation

> **Document**: 03-03-build-ci-security.md
> **Parent**: [Index](00-index.md)

## Overview

This component turns CI into a security gate: frozen installs, exact pins, full and
production dependency audits, SHA-pinned actions, a PostgreSQL 16/17 integration matrix,
artifact/content checks, and least-privilege workflow permissions.

## Architecture

### CI jobs

| Job id | Display name | Required |
|---|---|---|
| `verify` | `Verify` | Yes |
| `integration` | `Integration (${{ matrix.postgres }})` | Yes |
| `audit` | `Audit` | Yes |
| CodeQL | `Analyze JavaScript and TypeScript (javascript-typescript)` | Yes |
| Gitleaks | `Gitleaks` | Yes |
| Dependency review | `Review dependency changes` | Yes |

`Verify` runs without a database. `Integration (16)` and `Integration (17)` run only the
integration config. The required-check list uses the exact display names.

### Action pins

| Action | Tag | SHA |
|---|---|---|
| `actions/checkout` | `v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `pnpm/action-setup` | `v4` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| `actions/setup-node` | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `github/codeql-action` | `v3` | `4bfa242aa49c5f7c6770b98670d354a7dfac05f8` |
| `actions/dependency-review-action` | `v4.9.0` | `2031cfc080254a8a887f58cffee85186f0e49e48` |
| `gitleaks/gitleaks-action` | `v2` | `ff98106e4c7b2bc287b24eaf42907196329070c7` |
| `actions/configure-pages` | `v5` | `983d7736d9b0ae728b81ab479565c72886d7745b` |
| `actions/upload-pages-artifact` | `v3` | `56afc609e74202658d3ffba0e8f6dda462b719fa` |
| `actions/deploy-pages` | `v4` | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` |

Every `uses:` line is `owner/repo(/subpath)?@<40-hex>` with a tag comment. Dependabot updates
the SHAs; a mutable tag is never used.

### Workflow permissions

- Top-level `permissions: { contents: read }`.
- CodeQL adds `security-events: write` in its workflow.
- Docs workflow: `contents: read` at top level; `pages: write` and `id-token: write` only on
  the `deploy` job.
- `persist-credentials: false` on every checkout.
- No `pull_request_target`.

### CI commands

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm audit:prod
- run: pnpm audit:full
- run: pnpm verify
```

Gitleaks runs on every push/PR and on a weekly full-history schedule. A committed
`.gitleaks.toml` is CODEOWNERS-protected. If the organization requires a license for
`gitleaks-action`, set `GITLEAKS_LICENSE`; otherwise use the OSS CLI in the same job.

Integration job:

```yaml
name: Integration (${{ matrix.postgres }})
strategy:
  fail-fast: false
  matrix:
    postgres: [16, 17]
steps:
  - uses: actions/checkout@<sha>
    with: { persist-credentials: false }
  - uses: pnpm/action-setup@<sha>
    with: { version: 12.11.2 }
  - uses: actions/setup-node@<sha>
    with: { node-version: 22.23.3, cache: pnpm }
  - run: pnpm install --frozen-lockfile
  - run: pnpm build
  - run: pnpm test:integration
  - run: pnpm db:migrate
    env:
      OPENVAULT_DB_URL: postgres://openvault:test-password@localhost:5432/openvault_test
  - run: pnpm db:types:check
    env:
      OPENVAULT_DB_URL: postgres://openvault:test-password@localhost:5432/openvault_test
services:
  postgres:
    image: postgres:${{ matrix.postgres }}-alpine
    env:
      POSTGRES_DB: openvault_test
      POSTGRES_USER: openvault
      POSTGRES_PASSWORD: test-password
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U openvault -d openvault_test"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
env:
  TEST_DATABASE_URL: postgres://openvault:test-password@localhost:5432/openvault_test
  OPENVAULT_TEST_DB: "1"
```

### Build hygiene

- Every build script runs `rm -rf dist` first.
- `tsconfig.base.json` sets `sourceMap: false` and `declarationMap: false`; the web
  production build sets `sourcemap: false`.
- `scripts/check-artifacts.mjs` scans only `apps/*/dist`, `packages/core/dist`, and
  `packages/api-contract/dist`. It skips `node_modules`, `.vitepress`, and
  `packages/test-support`.
- It fails on `*.map`, `.env`, `.env.*`, `keyring.json`, `*.keyring`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, the test sentinel, and obvious private-key markers. It allows source files
  named `keyring.js` or `keyring.d.ts`.
- `scripts/check-single-react.mjs` accepts an optional root for tests, uses
  `pnpm -r list react` and `pnpm -r list @griffel/react`.
- `pnpm pack --dry-run` is not a separate gate; the artifact scan plus Gitleaks cover the
  publish surface.
- A secret-free `.env.example` is allowed; Gitleaks and the artifact scan still block real
  values in `dist`.

### Dependency policy

- Production dependencies exact.
- Dev dependencies exact except `@types/node`.
- `pnpm audit --prod --audit-level=high` and `pnpm audit --audit-level=high` both block.
- `pnpm-lock.yaml` committed; CI uses `--frozen-lockfile`.
- `pnpm-workspace.yaml` uses `dedupePeerDependents: true` and `strictPeerDependencies: true`.
- `vitepress` is pinned to `2.0.0-alpha.21`, which uses Vite 8 and clears the Vite 5 high
  advisory. The docs build remains a required verification step; revisit when VitePress 2 is
  stable.
- Build-script allowlist stays minimal (`@swc/core`, `esbuild`).
- Dependabot updates npm and GitHub Actions. Docker image digests are an RD-13 concern.

### Local test database

`deploy/compose/compose.test.yaml` provides two profiles:

```bash
docker compose -f deploy/compose/compose.test.yaml --profile pg16 up -d
TEST_DATABASE_URL=postgres://openvault:test-password@localhost:5433/openvault_test \
OPENVAULT_TEST_DB=1 pnpm test:integration
```

The PG17 profile uses port 5434. Both create the `openvault_test` database and publish the
port only on localhost.

## Implementation Details

### `scripts/check-artifacts.mjs`

- Accept an optional root argument for tests.
- Walk the fixed scan roots only.
- Fail on the name rules and content markers.
- Print every offending path and exit 1.
- Exit 0 on a clean tree.

### `scripts/check-single-react.mjs`

- Run `pnpm -r list react --depth 10 --json`.
- Run `pnpm -r list @griffel/react --depth 10 --json`.
- Collect resolved versions per project.
- Fail when more than one version exists for either package.

### Integration configs

- `apps/server/vitest.config.ts`: exclude `tests/integration/**`.
- `apps/server/vitest.integration.config.ts`: include only `tests/integration/**`,
  `maxWorkers: 1`, `environment: "node"`.
- `vitest.root.config.ts`: include `tests/**/*.{spec,impl}.test.mjs`.

## Error Handling

| Error case | Handling | AR Ref |
|---|---|---|
| High/critical audit finding (prod or dev) | CI fails | P-09 |
| Missing `TEST_DATABASE_URL` or `OPENVAULT_TEST_DB` | Integration suite fails with setup message | P-01, P-15 |
| Database name not `_test` or non-local host | Suite refuses to run | P-15 |
| Duplicate React or Griffel | `check:react` exits 1 | P-06 |
| Generated database types drift | `db:types:check` exits 1 | P-03, P-16 |
| Secret/map in build output | `check:artifacts` exits 1 | P-10 |
| Workflow tag instead of SHA | `tests/ci.spec.test.mjs` fails | P-10 |
| Postgres not ready | Service healthcheck gates the job | P-04 |

## Integration Points

- RD-02 uses the CI readiness and config checks.
- RD-14 extends this with signing/SBOM/provenance; RD-01 builds the gate.
- RD-01 schema tests run in both integration jobs.

## Testing Requirements

- ST-39 parses every `uses:` line, allows subpaths, and requires a 40-hex SHA plus tag
  comment.
- ST-42/43 run the artifact script against a temp root, including a clean tree and a tree with
  `keyring.js`, `server.key`, `.env`, and a `.map`.
- ST-44 runs the React check against a nested fixture.
- ST-41 uses `scripts/audit-check.mjs` with a fixture JSON and a failing advisory.
- Workflow permissions test asserts pages/OIDC permissions are deploy-only and checkout uses
  `persist-credentials: false`.
- Branch-protection read-back includes `Verify`, `Integration (16)`, `Integration (17)`,
  `Audit`, `Analyze JavaScript and TypeScript (javascript-typescript)`, `Gitleaks`, and
  `Review dependency changes`.

## Branch protection read-back

| Setting | Value |
|---|---|
| Required checks | `Verify`, `Integration (16)`, `Integration (17)`, `Audit`, `Analyze JavaScript and TypeScript (javascript-typescript)`, `Gitleaks`, `Review dependency changes` |
| Strict status checks | Enabled |
| Required approvals | 0 (single-maintainer project) |
| Dismiss stale reviews | Enabled |
| Linear history | Enabled |
| Force pushes | Disabled |
| Deletions | Disabled |
| Conversation resolution | Enabled |
| Admin enforcement | Enabled |
