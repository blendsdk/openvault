# Current State: Security Findings Remediation

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

### What Exists

The repository is a TypeScript monorepo using BlendSDK v5. The server is an Express/WebAFX application with PostgreSQL persistence, envelope encryption, audit chaining, RBAC, local/OIDC authentication, CLI JWT/refresh families, agent mTLS, and a Vite web UI.

The six findings were reproduced at `6ed6396ce613299707b149638515c7ab1c150992` against a disposable PostgreSQL 16 database and the real service classes. The reproduction harness was temporary and is not part of the repository.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `deploy/postgres/grants.sql` | Runtime/purger/pruner grants | Revoke control-plane writes from app; grant auth role; add auth role to schema usage |
| `deploy/postgres/roles.sql` | Role creation and default privileges | Create `openvault_auth`; do not grant it blanket default DML |
| `deploy/postgres/init-roles.sh` | First-boot role provisioning | Read `db_auth_password` |
| `deploy/compose/prepare.sh` | Host directory and secret preparation | Symlink-safe creation and ownership |
| `deploy/compose/compose.yaml` | Reference stack | Add auth password/URL secrets and server env |
| `apps/server/src/config/types.ts` | Config contract | Add `authDatabaseUrl`, `authDatabase`, OIDC endpoint origins |
| `apps/server/src/config/loader.ts` | Env validation | Parse auth URL, same-database check, OIDC origins |
| `apps/server/src/main.ts` | Process startup | Create auth pool; pass to runtimes; production privilege assertion |
| `apps/server/src/app.ts` | Composition root | Thread auth database into policy, identity, auth plugin |
| `apps/server/src/auth/plugin.ts` | Auth services | Use auth DB for credentials, CLI sessions, OIDC identities |
| `apps/server/src/rbac/runtime.ts` | Policy runtime | Use auth DB for policy persistence and assignments |
| `apps/server/src/identity/identity-runtime.ts` | Identity runtime | Use auth DB for principal writes |
| `apps/server/src/agent/agent-runtime.ts` | Agent runtime | Pass auth DB to policy/identity |
| `apps/server/src/security/signing-keys.ts` | JWT key lifecycle | Authenticate previous seed; immutable fields |
| `apps/server/src/database/schema.ts` + `apps/server/migrations/` | Schema | Add lifecycle trigger and any constraint |
| `apps/server/src/auth/oidc/client.ts` | OIDC discovery/exchange | Endpoint allowlist and redirect rejection |
| `apps/server/src/secrets/service.ts` | Secret purge | Allow event before delete; completion after |
| `apps/server/src/certificates/lifecycle.ts` | Certificate purge | Same order |
| `apps/server/src/secrets/service.ts` | Secret read/list | Collection-visibility denial mapping |
| `apps/server/src/certificates/service.ts` | Certificate read/private read | Collection-visibility denial mapping |
| `apps/server/src/projects/service.ts` | Project get by id | Keep control-plane 403/404; document boundary |
| `apps/server/tests/integration/` | Integration tests | Add role, purge, enumeration, signing-key tests |
| `apps/server/tests/auth/oidc.impl.test.ts` | OIDC unit tests | Add allowlist and redirect tests |
| `docs/security/limitations.md` | Accepted limitations | Update #21, #28 and add the auth-role boundary |
| `docs/reference/configuration.md` | Env reference | Document auth DB URL and OIDC origins |
| `docs/reference/api.md` | API behavior | Document the 403/404 matrix |

## Gaps Identified

### Gap 1: Runtime database role can forge auth state

**Current Behavior:** `openvault_app` has blanket DML. The auth and policy layers trust the rows.

**Required Behavior:** The app role cannot write the five control-plane tables. A dedicated auth role owns them.

**Fix Required:** Role separation, auth pool, config, Compose secrets, production assertion.

### Gap 2: Previous signing key is unauthenticated

**Current Behavior:** `#importPublicKey` imports arbitrary stored bytes.

**Required Behavior:** The previous public key must derive from the KEK-authenticated seed; lifecycle timestamps are immutable.

**Fix Required:** Seed unwrap + public-key derivation, trigger, tests.

### Gap 3: `prepare.sh` follows symlinks

**Current Behavior:** `-s`, `>`, `chmod`, `chown`, `mkdir -p` follow attacker-controlled links.

**Required Behavior:** Reject symlink components; create atomically.

**Fix Required:** Shell helpers and regression test.

### Gap 4: OIDC endpoints can leave the issuer origin

**Current Behavior:** Only the issuer is validated.

**Required Behavior:** Endpoint origins are allowlisted; redirects are rejected.

**Fix Required:** Config, discovery validation, fetch redirect policy, tests.

### Gap 5: Purge deletes before evidence

**Current Behavior:** The allow event is written after the purger transaction commits.

**Required Behavior:** The allow event is durable before the destructive delete.

**Fix Required:** Reorder secret and certificate purge; update limitation.

### Gap 6: Name enumeration through 403/404

**Current Behavior:** Unassigned callers get 403 for existing names and 404 for missing names.

**Required Behavior:** Callers that cannot list the collection get 404 for both. Callers that can list keep 403.

**Fix Required:** Collection-visibility helper and route updates.

## Dependencies

### Internal Dependencies

- Config loader → main/app composition → auth/RBAC/identity runtimes.
- PostgreSQL roles/grants → integration role test and Compose.
- Signing-key migration → integration tests.
- OIDC config → auth plugin and controller.
- Purge order → audit writer.
- Enumeration helper → secrets and certificates services.

### External Dependencies

None added. PostgreSQL, Node, pnpm, and the existing test stack are sufficient.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Auth pool refactor misses a write path | Medium | High | Startup privilege assertion; search every `local_credentials`/`role_assignments`/`oidc_identities`/`cli_sessions`/`principals` write; integration test |
| Tests use a superuser and hide role mistakes | High | Medium | Add a dedicated role/grant integration test; keep production assertion |
| Signing-key trigger blocks legitimate rotation | Low | High | Trigger allows `status`/`retired_at`; test rotation |
| OIDC allowlist breaks multi-origin providers | Medium | Medium | Explicit override config; fixture provider stays same-origin |
| Purge intent event changes audit semantics | Medium | Low | Use `details.phase`; update docs and tests |
| 403→404 change breaks clients | Medium | Medium | Only zero-grant/object-scope; update API docs and spec test deliberately |
| Compose secret wiring breaks review stack | Medium | Medium | `prepare.sh` + compose checks; review stack smoke test |
