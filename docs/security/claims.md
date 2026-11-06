# Security claims

> **Generated file.** Run `pnpm security:claims` after changing
> `docs/security/claims.json`. Every implemented claim links to executable
> evidence; every planned claim names the reason and the limiting document.

Updated: 2026-11-06

| ID | Claim | Status | Evidence or reason |
|---|---|---|---|
| C-01 | Secret and certificate values are encrypted with AES-256-GCM envelope encryption and a KEK outside the database. | implemented | test: `apps/server/tests/integration/secrets-crypto.spec.test.ts` — should encrypt and decrypt through the provider<br>test: `apps/server/tests/keyring.spec.test.ts` — serializes only status fields |
| C-02 | Backups are age-encrypted, checksum-verified, and restore into a fresh database. | implemented | test: `apps/server/tests/integration/ops.spec.test.ts` — should create a verifiable encrypted archive and reject tampering<br>test: `apps/server/tests/integration/ops.spec.test.ts` — should restore into an empty target and verify secrets, audit, CA, and agent certificate |
| C-03 | Agents authenticate with short-lived client certificates on a separate mTLS listener. | implemented | test: `apps/server/tests/integration/transport.spec.test.ts` — rejects missing and untrusted client certificates and accepts the trusted one<br>test: `apps/server/tests/integration/agent-join.spec.test.ts` — should join with a valid token and create one certificate and one consumer |
| C-04 | Every unsafe browser request requires a same-origin check and a per-session CSRF token. | implemented | test: `apps/server/tests/auth/csrf.spec.test.ts` — should reject an unsafe request with a wrong CSRF token<br>test: `apps/web/tests/session.test.tsx` — should add credentials and the CSRF header to unsafe methods |
| C-05 | Browser sessions rotate with a short retry receipt; CLI refresh families rotate and detect reuse. | implemented | test: `apps/server/tests/integration/auth.sessions.test.ts` — should rotate the secret and CSRF token on refresh while keeping the session identity<br>test: `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` — should revoke the whole family and reject the current refresh token when a rotated token is reused |
| C-06 | The audit chain detects edits, deletions, and tail truncation when a surviving link or checkpoint exists. | implemented | test: `apps/server/tests/integration/audit-verify.spec.test.ts` — should detect an edited details value and an edited hash<br>test: `apps/server/tests/integration/audit-verify.spec.test.ts` — should detect a deleted tail even when a newer checkpoint exists |
| C-07 | Secret values are not stored in browser storage, URLs, JavaScript-visible cookies, or logs. | implemented | test: `apps/web/tests/secret-detail.test.tsx` — should mask the value and read it only on reveal<br>test: `apps/server/tests/logging.spec.test.ts` — masks the documented top-level, one-level, and request-body paths |
| C-08 | Reference containers run non-root with read-only roots, dropped capabilities, no-new-privileges, and resource limits. | implemented | script: `scripts/check-compose.mjs` — validateCompose |
| C-09 | The runtime database role cannot run DDL or delete audit events, and migrations run as a separate owner role. | implemented | test: `apps/server/tests/integration/roles.spec.test.ts` — lets the runtime role read and write data but not run DDL or delete audit events |
| C-10 | Certificate expiry warnings fire once at 30, 14, and 7 days. | implemented | test: `apps/server/tests/integration/certificates-expiry.spec.test.ts` — should fire 30, 14, and 7-day warnings once per threshold |
| C-11 | The web UI is keyboard operable and passes automated accessibility checks for the login, secret, and audit screens. | implemented | test: `apps/web/tests/accessibility.test.tsx` — should pass axe on secret detail |
| C-12 | A restore drill covers backup, restore into a fresh target, audit verification, and a pre-backup agent certificate. | implemented | test: `apps/server/tests/integration/ops.spec.test.ts` — should restore into an empty target and verify secrets, audit, CA, and agent certificate |
| C-13 | Release images are amd64, signed with Cosign keyless, have an SBOM and provenance, and are scanned for HIGH/CRITICAL findings. | planned | planned: The release workflow is implemented; the first signed image awaits the release tag and the external review gate. |
| C-14 | An independent external review of crypto, auth/session, agent isolation, and deploy is complete for v0.1. | planned | planned: The review is an operator-provided gate. The packet and fail-closed approval file are in the repository; the production label remains blocked until it is approved. |
| C-15 | The deployment supports high availability, replication, or multi-region operation. | planned | planned: Out of scope for v0.1. The reference stack is single-node and the limitation is documented. |
| C-16 | Release images support multiple CPU architectures. | planned | planned: Out of scope for v0.1. The release pipeline builds amd64 only. |
| C-17 | The internal CA can be rotated online with a supported command. | planned | planned: CA rotation is not implemented in v0.1. A suspected CA compromise requires a fresh deployment, restore from a pre-compromise backup, new workstation identities, and new agent join tokens. |
