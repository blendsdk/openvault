# Ambiguity Register: Security Findings Remediation

> **Status**: ✅ GATE PASSED — all 14 items resolved
> **Last Updated**: 2026-11-06 19:19

## Planning scope

| Boundary | Value |
|---|---|
| Planning target | Issues #39–#44: six confirmed security findings at revision `6ed6396ce613299707b149638515c7ab1c150992` |
| Context artifacts | `docs/security/threat-model.md`, `docs/security/limitations.md`, `docs/security/external-review.md`, `docs/reference/api.md`, `deploy/postgres/*`, `deploy/compose/*`, affected server modules and tests |
| Modification set | This plan folder, implementation and tests under `apps/server`, `apps/web` (only if error mapping requires it), `deploy/postgres`, `deploy/compose`, and security/reference docs directly affected by the six fixes |

## Register

| # | Category | Ambiguity / Gap | Options Presented | Decision | Status |
|---|----------|-----------------|-------------------|----------|--------|
| 1 | Scope ambiguities | Which findings are in scope? | A: all six scanner findings · B: only High findings | A — all six issues #39–#44 | ✅ Resolved — User: “fix the problems… until all done” |
| 2 | Technical unknowns | How to stop the runtime role from forging `local_credentials`, `role_assignments`, `oidc_identities`, and `cli_sessions`? | A: separate `openvault_auth` role + optional auth pool · B: KEK-keyed row MACs · C: security-definer functions with signed writes | A — a direct PostgreSQL privilege boundary. Existing pattern, no new dependency or generalized framework. App role loses DML on the control-plane tables; auth role owns them. | ✅ Resolved — AI delegated by `--auto-design`: eligible security mechanism, smallest viable control that closes the credential/assignment/OIDC-link/session forgery chain. |
| 3 | Technical unknowns | Which tables belong to the control plane? | A: five auth/RBAC tables · B: five plus `join_tokens`, `workload_certs`, `consumers`, and `principals` | B — full control-plane split. Preflight proved `principals` row locks and agent credential tables are part of the same forgery surface; leaving them app-writable permits agent credential minting and revocation rollback. | ✅ Resolved — AI delegated by `--auto-design`: same trust boundary, no extra machinery beyond the chosen split. |
| 4 | Integration points | How does the server obtain the auth role credential? | A: new `OPENVAULT_AUTH_DB_URL` / `_FILE` · B: reuse migrator URL · C: reuse app URL with `SET ROLE` | A — separate URL and Compose secret; never grant app role membership in the auth role. B gives DDL; C lets a leaked app role escalate. | ✅ Resolved — AI delegated by `--auto-design`: least-privilege connection boundary. |
| 5 | Behavioral gaps | What happens when no auth URL is configured? | A: fall back to app URL · B: fail production startup · C: allow fallback only outside production | C — fall back in development/test for existing local flows; production startup asserts that `openvault_app` cannot write the control-plane tables and fails closed if it can. | ✅ Resolved — AI delegated by `--auto-design`: preserves tests/dev while enforcing production boundary. |
| 6 | Security & compliance | How should `SigningKeyService` authenticate a `previous` key? | A: unwrap seed and derive public key · B: store a public-key MAC · C: trust only `created_at` | A — unwrap the previous seed, derive the Ed25519 public key, and compare with the stored bytes using `timingSafeEqual`; add an immutable-lifecycle trigger for key material and timestamps. | ✅ Resolved — AI delegated by `--auto-design`: directly removes the unauthenticated public-key path. |
| 7 | Behavioral gaps | What is the response when the previous key fails authentication? | A: fail the whole service · B: ignore only the previous row; current tokens still verify | B — do not import the bad previous row; current-key tokens continue; previous-key tokens fail closed with 401. Surface the condition in logs/health. | ✅ Resolved — AI delegated by `--auto-design`: avoids a self-inflicted total outage while rejecting the forgery path. |
| 8 | Security & compliance | How should `prepare.sh` handle operator-selected directories? | A: reject symlinks and create atomically · B: document “do not use shared dirs” · C: rely on root ownership | A — reject symlink components, create files with `mktemp` + `mv`, verify `! -L` before chmod/chown, and document root ownership. | ✅ Resolved — AI delegated by `--auto-design`: direct control using shell/POSIX tools already in the script. |
| 9 | Security & compliance | How should OIDC endpoint origins be constrained? | A: default-deny origin allowlist · B: same-origin only · C: allowlist + redirects disabled | C — `OPENVAULT_OIDC_ENDPOINT_ORIGINS` defaults to the issuer origin; token/JWKS/UserInfo/authorization endpoints must be HTTPS and listed; `redirect: "error"` prevents cross-origin redirects. | ✅ Resolved — AI delegated by `--auto-design`: preserves legitimate multi-origin providers while enforcing explicit trust. |
| 10 | Behavioral gaps | How should purge evidence be made durable? | A: atomic outbox table + reconciliation · B: intent-first allow event before delete + completion after · C: keep the documented limitation | B — write the actor-attributed allow decision before the destructive delete, then a completion event after; update limitation #28 to describe the residual completion-only window. Smallest direct control; no new table or worker. | ✅ Resolved — AI delegated by `--auto-design`: Low severity, no new support surface. |
| 11 | Security & compliance | How should name-addressed 403/404 enumeration be fixed? | A: blanket 404 · B: keep 403 + rate limits · C: collection-visibility rule | C — a caller may learn that a named resource exists only if they can list the collection. Callers with `secret.list`/`certificate.list` keep 403 on object denial; callers without it get 404 for both existing and missing. ID-addressed control-plane routes keep 403/404. | ✅ Resolved — User accepted recommendation: collection-visibility rule from the preceding discussion. |
| 12 | Naming & terminology | What are the new configuration and role names? | A: `OPENVAULT_AUTH_DB_URL`, `openvault_auth`, `OPENVAULT_OIDC_ENDPOINT_ORIGINS` · B: other names | A — these names describe the trust boundary and match the existing `OPENVAULT_*_DB_URL` and role naming. | ✅ Resolved — AI delegated by `--auto-design`: naming only; no behavior change. |
| 13 | Integration points | How does an existing database get the new auth role? | A: idempotent `ensure-auth-role.sql` in the existing `openvault-roles` job · B: require a fresh database · C: manual operator step | A — the role job runs on every deployment, reads `db_auth_password`, and creates/resets the role before grants. | ✅ Resolved — AI delegated by `--auto-design`: upgrade safety is directly required by the boundary. |
| 14 | Security & compliance | What must the production startup assertion check? | A: app INSERT only · B: app and auth INSERT/UPDATE/DELETE plus auth superuser/ownership/membership | B — checks all three write verbs on all eight tables, auth required grants, and rejects an over-privileged auth connection. | ✅ Resolved — AI delegated by `--auto-design`: the guard must be at least as strong as the grant contract. |

## Delegated provenance

> Policy version: 1
> Root invocation ID: `secfix-20261106-1919`
> Parent workflow: make-plan → preflight → exec-plan
> Delegated categories: algorithms, internal architecture/interfaces, failure/recovery design, persistence and reversible migrations, security mechanisms within the approved remediation policy, testing strategy, implementation sequencing, naming.
> Reserved categories: product behavior/scope, priorities/acceptance criteria, access and security policy, data retention, risk acceptance, public compatibility breaks, destructive migrations, credentials, deployment/publication.
> Permission state: implementation and `--auto-commit` authorized by the user objective; push is authorized by the selected commit mode.

**AR-2 / AR-3:** `deploy/postgres/grants.sql:13` grants blanket DML to `openvault_app`; the only revokes are audit deletes and key tables (`:15-21`). The runtime then trusts `local_credentials` (`apps/server/src/auth/credentials.ts:100-126`), `role_assignments` (`apps/server/src/rbac/policy-repository.ts:313-370`), `oidc_identities` (`apps/server/src/auth/oidc/identity.ts:104-188`), and `cli_sessions` (`apps/server/src/auth/cli-sessions.ts:289-310`). `principals` is also security-relevant because `owner_project_id`, `status`, and `email` affect identity and agent scope. `join_tokens`, `workload_certs`, and `consumers` are agent credentials and must not remain app-writable. A dedicated control-plane role is the smallest PostgreSQL-native boundary. Residual application-process compromise remains an accepted limitation.

**AR-4:** The auth URL is validated to target the same database host, port, and database as `OPENVAULT_DB_URL`, matching the existing purge URL validation (`apps/server/src/config/loader.ts:481-498`). The Compose stack adds `db_auth_password` and `db_auth_url`; `prepare.sh` creates both. The auth role never owns tables and never receives DDL.

**AR-5:** The production assertion runs `has_table_privilege` for `openvault_app` on `principals`, `local_credentials`, `role_assignments`, `oidc_identities`, and `cli_sessions`. Development/test may share the app URL because integration databases use a superuser maintenance connection and do not model production grants.

**AR-6 / AR-7:** `apps/server/src/security/signing-keys.ts:755-764` imports the previous public key directly; `:847-855` imports raw bytes; `:866-867` trusts mutable `current.activated_at`. The fix reuses `unwrapSigningSeed` (`:192-228`) and adds a trigger that rejects UPDATE of key material and lifecycle timestamps.

**AR-8:** `deploy/compose/prepare.sh:46-56,58-71,73-76,94-104` follows symlinks through `-s`, `>`, `chmod`, `chown`, and `mkdir -p`. The fix uses `mktemp` in the target directory, `mv` to replace a symlink, and explicit `! -L` checks. `set -C` alone is insufficient.

**AR-9:** `apps/server/src/auth/oidc/client.ts:240-274` checks only the issuer; `:118-128` forwards all library URLs. The allowlist check runs after discovery and before caching the configuration. `redirect: "error"` prevents a 30x from moving a request outside the allowlist. Existing fixture providers remain valid because their endpoints are on the issuer origin.

**AR-10:** `apps/server/src/secrets/service.ts:1056` deletes before `:1138` writes the allow event; `apps/server/src/certificates/lifecycle.ts:365` and `:419` have the same order. Writing the authorization event before the delete closes the “no evidence” window; a completion event after the delete records the successful outcome. A crash or audit outage can leave `authorized` without `completed`, which means the outcome is unknown; limitation #28 is updated accordingly.

**AR-11:** `apps/server/src/rbac/roles.ts:140-158` gives `reader` and `auditor` list but not read; a blanket 404 would make a listed name appear missing. The collection-visibility rule preserves 403 for callers who can list or already know the object while hiding existence from zero-grant and object-scope callers. Hidden and missing responses use the same status, code, and message. The existing spec tests listed in `03-06-name-enumeration.md` must change deliberately.

**AR-13:** `deploy/postgres/init-roles.sh` runs only on an empty data directory. `deploy/postgres/ensure-auth-role.sql` runs from the `openvault-roles` job on every deployment, before `grants.sql`, and is idempotent.

**AR-14:** The startup assertion checks `INSERT`, `UPDATE`, and `DELETE` for the app role on all eight tables, the same verbs as true for the auth role, required auth reads/audit grants, and rejects a superuser, table owner, or migrator member on the auth connection. A dedicated `AuthPrivilegeError` prints a safe message.

## Gate evidence

- All decisions trace to the six issue bodies, the scanner CSV, or the user’s preceding collection-visibility decision.
- No material item is deferred.
- Specification tests are ordered before implementation in `99-execution-plan.md`.
- No new dependency, framework, queue, cache, or generalized abstraction is introduced. The auth role is a direct PostgreSQL privilege control required by the finding.
