# Requirements: Security Findings Remediation

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-14](../../requirements/RD-14-security-release.md) — security assurance parent

## Scope of this plan (delta view)

### In this plan

| ID | Requirement | Issue | AR Ref |
|---|---|---|---|
| R1 | The runtime database role cannot mint or alter credentials, role assignments, OIDC links, CLI sessions, join tokens, workload certificates, or consumers. | #41 | AR-2…AR-5 |
| R2 | A `previous` JWT signing key is accepted only when its public key is derived from a KEK-authenticated seed; only `current→previous` and `previous→retired` transitions are allowed. | #39 | AR-6, AR-7 |
| R3 | `prepare.sh` refuses symlinked paths, creates files atomically, and preserves non-empty secrets across reruns. | #40 | AR-8 |
| R4 | OIDC token, JWKS, UserInfo, and authorization endpoints are HTTPS and restricted to an explicit origin allowlist; redirects are rejected. | #42 | AR-9 |
| R5 | Secret and certificate purge write a durable actor-attributed authorization event before the destructive delete and a completion event after it. | #43 | AR-10 |
| R6 | Name-addressed data-plane denials hide existence from callers that cannot list the collection or read the object; hidden and missing responses are identical in status, code, and message. | #44 | AR-11 |

### Deferred / out of this plan

- KEK-keyed integrity MACs over all auth rows (AR-2 follow-up). The role split is the selected boundary.
- A purge outbox table and reconciliation worker (AR-10). Intent-first evidence is the selected control.
- Changes to agent workload-certificate ownership tables. The reported finding covers auth/RBAC state; agent tables are a separate review.
- A production image release or external security review approval. RD-14 owns the release gate.

## Plan-local requirements

### Must Have

- [ ] R1: `openvault_app` has no `INSERT`, `UPDATE`, or `DELETE` on `principals`, `local_credentials`, `role_assignments`, `oidc_identities`, `cli_sessions`, `join_tokens`, `workload_certs`, or `consumers`.
- [ ] R1: auth, RBAC, identity, agent identity, and CLI paths use the auth pool when `OPENVAULT_AUTH_DB_URL` is configured.
- [ ] R1: production startup fails closed when the app role still has control-plane writes or the auth role is over-privileged.
- [ ] R2: a mismatched previous key is not imported; a token signed by it is rejected.
- [ ] R2: `UPDATE signing_keys SET activated_at = ...` is rejected.
- [ ] R3: a symlinked secret, URL, or directory path causes a non-zero exit before any target change.
- [ ] R3: a normal run still creates `0444` secrets and the expected directory modes.
- [ ] R4: cross-origin OIDC endpoints are rejected by default; an explicit allowlist accepts only listed origins.
- [ ] R4: a redirect to a different origin is rejected.
- [ ] R5: the authorization event is durable before the purge transaction starts.
- [ ] R5: a completion event follows a successful purge; its failure does not remove the earlier evidence.
- [ ] R6: unassigned and object-scope callers get 404 for existing and missing names, with identical status, code, and message.
- [ ] R6: list-capable callers keep 403 for an existing object they cannot read; object-scope readers keep 403 for their known object.
- [ ] All security tests are written before implementation and fail for the expected reason.
- [ ] `pnpm verify` and the affected integration suites pass.

### Should Have

- [ ] A startup health signal when pending purge completion evidence exists.
- [ ] A startup warning when OIDC endpoints are allowlisted but cross-origin.

### Won’t Have (Out of Scope)

- Multi-tenant policy redesign.
- A new database, cache, queue, or external service.
- Changes to the external review gate.

## Acceptance Criteria

1. [ ] All six issue regression tests fail before the fix and pass after it.
2. [ ] `openvault_app` cannot write the eight control-plane tables.
3. [ ] `prepare.sh` rejects file and directory symlinks without touching targets.
4. [ ] OIDC discovery with a cross-origin token, JWKS, or UserInfo endpoint is rejected unless explicitly allowlisted.
5. [ ] A purge audit outage after authorization leaves durable allow evidence.
6. [ ] The enumeration matrix in `07-testing-strategy.md` passes for unassigned, list-only, object-scope, and project-scope callers.
7. [ ] `pnpm verify` passes.
8. [ ] The affected integration suites pass against PostgreSQL 16 and 17.
9. [ ] Security limitations and reference docs reflect the new behavior.

## Compatibility Notes

- R1 adds `OPENVAULT_AUTH_DB_URL` / `_FILE` and an idempotent role-creation step for existing databases. The reference Compose stack supplies it; development and tests may share the app URL, but production fails closed without the boundary.
- R4 adds `OPENVAULT_OIDC_ENDPOINT_ORIGINS`. Its default preserves same-origin providers; multi-origin providers require an explicit list.
- R6 changes the HTTP response for zero-grant and object-scope denials from 403 to 404. This is a deliberate pre-1.0 contract change; list-capable callers keep 403.
