# Auth and crypto design challenge — OpenVault v0.1

> **Resolution**: see [00-resolution.md](00-resolution.md). The counts below are the findings at review time; all High findings are fixed.


**Scope:** `docs/architecture/crypto.md`, `docs/architecture/identity.md`,
`docs/security/threat-model.md`, the auth, security, and operations implementation under
`apps/server/src`, and the auth/ops/agent integration tests.

**Reviewer role:** Independent design challenger (security architecture). Not an author of
the design or implementation.

**Date:** 2026-11-06

**Reviewed tree:** commit `cae3197` plus the uncommitted working-tree changes present on
2026-11-06. No code was modified by this review.

**Method:** Read the design documents, the implementation, and the tests. Traced the trust
boundaries for browser sessions, CLI tokens, agent mTLS, the KEK, the CA, audit, backup,
restore, and release. No tests were executed for this report; every claim below is grounded
in the cited source.

## Verdict

**Conditional.** The cryptographic core and the main authentication flows hold up. The
design is **not yet sufficient for a production-labelled self-hosted secret store** because
the root-of-trust lifecycle is not fail-safe. It is defensible as an **alpha** only when the
reference Compose stack is used, `OPENVAULT_PROXY_CIDRS` is pinned, the server is stopped for
rotation and restore, and the restore output is inspected by an operator.

The problem is not AES-GCM, the envelope AAD, the `__Host-` cookie, CSRF, PKCE, or the agent
certificate profile. Those are sound. The problem is that several security-critical
operations depend on an operator remembering a runbook step, while the code's failure mode is
silent and sometimes irreversible.

## Strongest argument

The strongest argument that this design is wrong or insufficient is:

> **The KEK is a single plaintext point of failure, and the operations that protect it are
> not safe by construction.** KEK rotation can leave a value encrypted under a key that the
> command then deletes; restore commits the database and publishes a new keyring and CA
> before it verifies them; and the CA has no supported rotation path despite an incident
> response procedure that assumes one. Each is documented as an operational limitation, but
> the compensating control is prose, not code. For a secret store, "documented" is not the
> same as "enforced": one missed step turns a routine key-management action into permanent
> data loss or a re-enabled revoked identity.

If an operator follows every runbook exactly and the deployment is the pinned reference
Compose stack, v0.1 is defensible as an alpha. It is not sufficient for a production label
until rotation and restore either fail safe or refuse to run when their preconditions are not
met.

## Design decisions challenged

| # | Decision as stated | Challenge | Evidence |
|---|---|---|---|
| 1 | KEK rotation is a maintenance-window operation: stop the server, rotate, remove the old key. | The command cannot detect a live server. The final keyring drops the old key after a count check that a concurrent writer can invalidate. A late row is then undecryptable. | `apps/server/src/ops/kek.ts:263-470`, `:472-487`, `:489-498`; `apps/server/src/security/keyring.ts:41-48`, `:138-140`; `docs/guide/rotation.md:16-19`; `docs/security/limitations.md:151-153` |
| 2 | Restore verifies the archive before the instance is used. | The database is committed and the keyring/CA are published before verification. A failed verification exits non-zero but leaves a startable instance. Verification is sampled. | `apps/server/src/ops/restore.ts:520-550`, `:552-614`; `:274-341`; `docs/security/limitations.md:173-177` |
| 3 | The admin listener is proxy-only behind `OPENVAULT_PROXY_CIDRS`. | The default is `172.16.0.0/12`, which contains typical Docker agent/database peers, and the listener binds `0.0.0.0`. A non-reference deployment that forgets the variable is fail-open. | `apps/server/src/config/loader.ts:19`, `:407-412`; `apps/server/src/transport/secure-application.ts:101`; `apps/server/src/transport/pre-stack.ts:72-102`, `:345-349`; `deploy/compose/compose.yaml:147` |
| 4 | `kek_id` identifies the key that wrapped a row. | `nextKekId` reuses a removed identifier on the next rotation. After `kek-2`, the next ID is `kek-1` again, so the identifier no longer identifies a unique key generation. | `apps/server/src/ops/kek.ts:53-61`, `:212`, `:489-498`; `packages/core/src/crypto.ts:99-104`; `apps/server/src/audit/audit-key-store.ts:35-37` |
| 5 | Browser refresh rotation limits the value of a stolen cookie. | A ten-second receipt for the old secret lets any holder of the old cookie obtain the new secret and CSRF token. Rotation is a retry aid, not a theft detector. The test asserts this. | `apps/server/src/auth/sessions.ts:14`, `:360-385`, `:387-416`; `apps/server/tests/integration/auth.sessions.test.ts:329-335` |
| 6 | Agent renewal rotates the workload key and contains a stolen certificate. | Renewal requires only the current certificate and a fresh CSR. A thief can renew with their own key; the legitimate agent is no longer newest and cannot renew. Theft becomes persistent until revocation. | `apps/server/src/agent/agent-renew-service.ts:250-338`; `docs/architecture/identity.md:58-60`; `docs/security/threat-model.md:42` |
| 7 | A verified email that belongs to another principal is linked by an administrator. | There is no link route or CLI. The only paths are JIT creation or a direct SQL insert. | `apps/server/src/auth/oidc/identity.ts:104-161`; `apps/server/src/controllers/identity.ts:53-122`; `docs/architecture/identity.md:25-28` |
| 8 | The audit chain detects edits, deletions, and tail truncation. | An empty event table with no checkpoints returns `ok: true`. A database administrator who deletes every event and checkpoint leaves a state the API reports as valid. | `apps/server/src/audit/audit-verify.ts:118-125`; `apps/server/tests/integration/audit-verify.spec.test.ts:202-210`; `docs/security/claims.md:16`; `docs/security/limitations.md:13-18` |
| 9 | The production label is gated by an approved external review. | The gate reads a mutable Markdown file, checks only a version string, and does not bind to a commit or digest. A production dispatch can run from any branch. The image is tagged before the scan. | `scripts/check-release-gate.mjs:36-57`; `docs/security/external-review.md:3-14`; `.github/workflows/release.yml:8-13`, `:60-66`, `:138-167`; `docs/security/release-process.md:10-12`, `:21-25` |
| 10 | The server fails closed when the server certificate does not chain to the restored CA. | Runtime `TlsMaterial` checks the key match and the CA self-signature but never `checkIssued`. The init path does check; the running server does not. | `apps/server/src/transport/tls.ts:78-121`, `:128-140`; `apps/server/src/init/tls.ts:147-155`; `docs/guide/backup-restore.md:81-83` |
| 11 | Old backups remain restorable after rotation. | The product archive is self-contained, but a database-only dump or PITR snapshot is unreadable once the old KEK is removed. The backup guide lists a logical dump and keyring as separate items. | `apps/server/src/ops/kek.ts:489-498`; `docs/guide/backup-restore.md:3-15`; `docs/guide/operations.md:130-133` |
| 12 | A compromised CA is recoverable by replacing it and re-issuing workload identities. | No supported CA rotation path exists. `CaSigner` loads the single current row; `init` returns an existing current row; no command retires it and creates a new one. | `apps/server/src/security/ca.ts:310-328`; `apps/server/src/init/ca.ts:81-91`; `docs/security/incident-response.md:55-60` |
| 13 | CSRF covers every unsafe browser request. | The guard exempts `/v1/auth/cli` by path, not by auth kind. `sessionMiddleware` still attaches a browser context to those paths. No current route abuses it, but the boundary is fragile. | `apps/server/src/auth/csrf.ts:50-55`, `:111-113`; `apps/server/src/auth/middleware.ts:62-95`; `apps/server/src/auth/plugin.ts:157-161` |

## Findings

| ID | Severity | Type | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| AC-01 | High | Design flaw | **Admin listener trusts the broad default proxy CIDR and binds all interfaces.** With `OPENVAULT_PROXY_CIDRS` unset, any peer in `172.16.0.0/12` is treated as the proxy. In a typical Docker network, agent and database containers are in that range and can reach `:8443` on the server's non-admin interfaces, bypassing the B1 proxy-only boundary and spoofing `X-Forwarded-For`. The reference Compose stack pins `172.30.0.2/32`, so this is a default/custom-deployment failure, not a reference-stack failure. | `apps/server/src/config/loader.ts:19`, `:407-412`; `apps/server/src/transport/secure-application.ts:101`; `apps/server/src/transport/pre-stack.ts:72-102`, `:345-349`; `deploy/compose/compose.yaml:147`; `docs/guide/docker-compose.md:86-89` | Fail startup in production when the broad default is used, or default to loopback. Bind the admin listener to a dedicated address. Require an explicit CIDR in every deployment manifest. Test that an out-of-CIDR peer gets 403 and that a non-proxy peer cannot reach admin routes. |
| AC-02 | High | Accepted limitation (un-enforced control) | **KEK rotation can orphan data when the server is running.** The rewrap transaction and the count check are separate from the final keyring write. A live server holds the old keyring in memory and can write a row under the old `kek_id` after the check; the final keyring then deletes that key. The value is permanently lost. The docs say to stop the server, but the command cannot verify it. | `apps/server/src/ops/kek.ts:263-470`, `:472-487`, `:489-498`; `apps/server/src/security/keyring.ts:41-48`, `:138-140`; `apps/server/src/auth/plugin.ts:73-77`; `docs/guide/rotation.md:16-19`; `docs/security/limitations.md:151-153` | Make rotation safe by construction: a database advisory lock or keyring epoch that every server acquires and checks before writing; or keep the old key until an explicit `--retire-old` after a verified quiet period; or implement online dual-key reads. Add a concurrent-writer rotation test. |
| AC-03 | Medium | Accepted limitation (weak control) | **Restore commits and publishes before verification, and verification is sampled.** A failure in the audit chain, a sampled secret, or the CA probe leaves a startable instance with unverified state. Verification covers one current secret per project, no certificate private keys, and no JWT signing probe. There is no durable `restore verified` marker. | `apps/server/src/ops/restore.ts:520-550`, `:552-614`; `:274-341`; `apps/server/src/readiness/service.ts:90-139`; `docs/security/limitations.md:173-177` | Verify the archive and staged keyring/CA before publishing. Write a `restore_verification` row that `/ready` refuses until every current secret and certificate private key, the audit chain, the CA, and the JWT signer pass. Or fail the instance closed and keep the staged files for manual recovery. |
| AC-04 | Medium | Design flaw | **Restore is an authenticated full rollback with no freshness check or actor attribution.** An old archive restores old principals, role assignments, password hashes, CLI families, join tokens, and unrevoked workload certificates; it can undo a revocation or role removal. The `backup.restore` event is written as `system` with no operator identity, archive SHA-256, or manifest timestamp. | `apps/server/src/ops/restore.ts:397-614`, `:588-600`; `apps/server/src/ops/audit.ts:20-42`; `apps/server/src/ops/archive.ts:26-32`; `docs/guide/backup-restore.md:104-114` | Compare the archive's newest checkpoint with the latest off-box checkpoint and refuse an older archive without `--accept-rollback`. After restore, revoke all agent certificates, join tokens, CLI families, and browser sessions and force password changes. Record the archive SHA-256, manifest `createdAt`, operator identity, and target in the audit event. |
| AC-05 | Medium | Design flaw | **KEK identifiers are reused.** `nextKekId` scans from `kek-1` over only the IDs currently present. After the first rotation the keyring contains only `kek-2`; the next rotation picks `kek-1` again. `kek_id` no longer identifies a unique key generation, although the DEK/audit AAD and rotation checks treat it as one. A database/keyring mismatch from different generations fails closed but is indistinguishable from corruption. | `apps/server/src/ops/kek.ts:53-61`, `:212`, `:489-498`; `packages/core/src/crypto.ts:99-104`; `apps/server/src/security/ca.ts:108-110`; `apps/server/src/audit/audit-key-store.ts:35-37` | Use a monotonic counter persisted in the keyring or ULIDs. Never reuse a retired identifier. Add a two-rotation test that asserts distinct IDs and that a pre-rotation archive still restores. |
| AC-06 | Medium | Design flaw (deliberate tradeoff) | **Browser refresh rotation keeps a ten-second replay receipt.** Any holder of the old cookie can call `POST /v1/auth/refresh` within ten seconds of the legitimate rotation and receive the new secret and CSRF token. The integration test asserts this. Rotation therefore does not detect theft; it only limits the window. | `apps/server/src/auth/sessions.ts:14`, `:360-385`, `:387-416`; `apps/server/tests/integration/auth.sessions.test.ts:329-335`; `docs/architecture/identity.md:12-16` | Treat reuse of an old secret outside the same retry as compromise and revoke the session family, or scope the receipt to one request and document it as a retry aid. Consider an idle timeout or re-authentication for sensitive actions. |
| AC-07 | Medium | Accepted limitation (weak control) | **Agent renewal makes a stolen certificate persistent.** Renewal requires only the current certificate and a fresh CSR. A thief can renew with their own key; the legitimate agent is no longer newest and cannot renew. The theft survives until an administrator revokes the identity. The threat row says "until revoked" but does not say renewal can extend the theft indefinitely. | `apps/server/src/agent/agent-renew-service.ts:250-338`; `apps/server/src/agent/agent-authenticator.ts:116-198`; `docs/architecture/identity.md:58-60`; `docs/security/threat-model.md:42` | Require a second factor for a key-changing renewal (short-lived join token or admin approval), or bind renewal to a per-agent secret stored outside the certificate. At minimum, alert or deny on consumer metadata change and provide a one-step per-certificate revoke. |
| AC-08 | Medium | Implementation/doc gap | **OIDC email collision has no administrator link path.** JIT refuses a verified email that belongs to another principal, and the design says an administrator must link it. There is no link route or CLI; the only paths are JIT creation or a direct SQL insert. The user is permanently denied. | `apps/server/src/auth/oidc/identity.ts:104-161`; `apps/server/src/controllers/identity.ts:53-122`; `docs/architecture/identity.md:25-28` | Add an audited `POST /v1/admin/identities/:id/oidc-links` (or CLI) requiring an `identity.link` action and re-verification of the issuer/subject. Or document the supported manual procedure and remove the claim that an administrator can link. |
| AC-09 | Medium | Claim/trust gap | **Audit verification reports an empty chain as valid.** An event table with no rows and no checkpoints returns `ok: true`. A database administrator who deletes every event and checkpoint leaves a state the API reports as valid. The claims ledger says the chain detects deletions without this qualification. | `apps/server/src/audit/audit-verify.ts:118-125`; `apps/server/tests/integration/audit-verify.spec.test.ts:202-210`; `docs/security/claims.md:16`; `docs/security/limitations.md:13-18` | Return `unverifiable`/`empty_chain` rather than `ok` unless an off-box checkpoint or a chain-initialized marker proves the expected state. Narrow the claim to "detects deletions that leave a link or checkpoint". |
| AC-10 | Medium | Process gap | **The production-label gate is not bound to the reviewed artifact.** It checks only `Status`, `Release` (a version string), and open Critical/High counts in a mutable Markdown file. It does not bind approval to a commit or image digest. `workflow_dispatch` accepts `mode=production` from any branch, so an already-approved version string can label different code. The `Reviewer` field is not checked. | `scripts/check-release-gate.mjs:36-57`; `docs/security/external-review.md:3-14`; `.github/workflows/release.yml:8-13`, `:60-66`; `docs/security/release-process.md:10-12` | Record and verify the reviewed commit SHA and image digest in the approval artifact. Reject production dispatch except from a signed tag, verify the tag signature, check `Reviewer` is not `not assigned`, and add gate tests. |
| AC-11 | Medium | Process gap | **The image is pushed and tagged before the scan and signature.** `docker/build-push-action` uses `push: true` with the final tags, then Trivy scans the digest. A failing scan aborts the job but leaves the tagged, unsigned image in the registry. The release-process document shows scan and sign before push. | `.github/workflows/release.yml:138-167`, `:177-191`; `docs/security/release-process.md:21-25` | Build to a staging tag or an untagged digest, scan and sign, then promote the digest to the release tags in a separate job. Never publish a production tag before the scan passes. |
| AC-12 | Medium | Doc/implementation gap | **Runtime TLS does not verify that the server certificate chains to the configured internal CA.** `TlsMaterial.load` and `checkReady` check key match, validity, and CA self-signature only. After a restore with a different CA, the server can start and report ready with a leaf the proxy will reject. The restore guide claims the server fails closed. | `apps/server/src/transport/tls.ts:78-121`, `:128-140`; `apps/server/src/init/tls.ts:147-155`; `docs/guide/backup-restore.md:81-83` | Call `certificate.checkIssued(caCertificate)` and verify the signature in `TlsMaterial.load` and `checkReady`. Add a restore test where the CA changes and the server refuses to start. |
| AC-13 | Medium | Missing capability/doc gap | **There is no supported CA rotation or replacement path.** The incident-response runbook says a compromised CA is recoverable by replacing it, re-issuing workload identities, and re-provisioning the server TLS pair. `CaSigner.load` selects the single current row; `init` returns an existing current row; no command retires it and creates a new one. The architecture page still says CA generation, backup, and restore are later work, but they are implemented. | `apps/server/src/security/ca.ts:310-328`; `apps/server/src/init/ca.ts:81-91`; `apps/server/src/ops/kek.ts:407-430`; `docs/security/incident-response.md:55-60`; `docs/architecture/crypto.md:31-33` | Add `ov ca rotate` (new CA, new server certificate, new agent join tokens, retire the old row, publish the new `ca.pem`). Or declare CA compromise unrecoverable and remove the runbook claim. Align `crypto.md` with the implemented CA generation, backup, and restore. |
| AC-14 | Low | Process bug | **The production gate's parser does not match the approval file's format.** `field()` requires a line beginning `Status:`; the file uses blockquoted `> **Status**:`. Following the documented format cannot satisfy the gate. | `scripts/check-release-gate.mjs:16-20`; `docs/security/external-review.md:3-13` | Use plain `Key: value` lines or parse the blockquote/table format. Add a unit test for both Pending and Approved shapes. |
| AC-15 | Low | Doc gap | **Database-only backups and PITR become unreadable after KEK rotation.** The final keyring contains only the new key. The product archive is self-contained, but the backup guide lists a logical dump and keyring as separate items and does not explicitly prohibit database-only snapshots. | `apps/server/src/ops/kek.ts:489-498`; `docs/guide/backup-restore.md:3-15`; `docs/guide/operations.md:130-133`; `docs/security/limitations.md:149-153` | State that only `ov backup` archives are supported and database-only backups/PITR are unrecoverable after rotation. Or retain retired KEKs for the backup retention window. |
| AC-16 | Low | Implementation gap | **`CaSigner.load` does not check the CA certificate validity window.** Restore uses it to probe the archived CA and can report `caVerified: true` for an expired CA; the runtime `TlsMaterial` would reject the configured CA later. | `apps/server/src/security/ca.ts:356-379`; `apps/server/src/ops/restore.ts:327-341`; `apps/server/src/transport/tls.ts:118` | Check `notBefore`/`notAfter` in `CaSigner.load` and in the restore preflight. |
| AC-17 | Low | Defense in depth | **The log redaction list omits OIDC client secret and backup passphrase.** The current handlers do not log them, but the redaction list is the defense-in-depth boundary for future config or error logs. | `apps/server/src/observability/logger.ts:13-111`; `apps/server/src/config/types.ts:26`; `apps/server/src/ops/backup.ts:27-28` | Add `clientSecret`, `passphrase`, `OPENVAULT_OIDC_CLIENT_SECRET`, and `OPENVAULT_BACKUP_PASSPHRASE_FILE`. Add a redaction test. |
| AC-18 | Low | Hardening gap | **OIDC UserInfo overrides ID-token claims, including `email_verified`.** `merged = { ...claims, ...userInfo }` trusts the UserInfo value when both are present. The ID token is the stronger assertion. | `apps/server/src/auth/oidc/identity.ts:121-124` | Use ID-token claims for identity and email, and fill only missing fields from UserInfo. Require `email_verified === true` in both when both are present. |
| AC-19 | Low | Defense in depth | **The CSRF/origin guards exempt `/v1/auth/cli` by path, while `sessionMiddleware` still attaches a browser context to those paths.** Current CLI routes do not read the browser context, so there is no exploitable bypass today. A future CLI route that reads the cookie would bypass CSRF. | `apps/server/src/auth/csrf.ts:50-55`, `:111-113`; `apps/server/src/auth/middleware.ts:62-95`; `apps/server/src/auth/plugin.ts:157-161` | Key the exemption on `req.auth?.kind !== "browser"` rather than the path, and add a test for a browser-cookie POST to a CLI path. |

## What holds up

These are not findings; they are the parts of the design I would keep unchanged.

| Area | Why it holds | Evidence |
|---|---|---|
| Envelope encryption | Per-version DEK, AES-256-GCM, canonical base64, unknown-field rejection, AAD binds object type/project/id/version, both tags verified, bounded ciphertext. | `packages/core/src/crypto.ts:92-104`, `:155-266`; `docs/architecture/crypto.md:35-66` |
| Keyring custody | Absolute path, `O_NOFOLLOW`, exact `0600`, owner check, non-writable directory, status-only JSON and `inspect`, idempotent destroy. | `apps/server/src/security/keyring.ts:41-99`, `:158-167`; `packages/core/src/keyring.ts:48-206` |
| Browser session | 32-byte secret, SHA-256 cache key, `__Host-` HttpOnly/Secure/SameSite=Lax, absolute expiry, rotation, per-session CSRF, exact-origin and `Sec-Fetch-Site` checks. | `apps/server/src/auth/sessions.ts`; `apps/server/src/auth/cookie.ts:59-67`; `apps/server/src/auth/csrf.ts:34-120` |
| OIDC | PKCE S256, single-use state, nonce, hashed browser-binding cookie, tokens discarded, JIT requires verified email and an exact allowed domain, collision never auto-links. | `apps/server/src/auth/oidc/*`; `apps/server/src/controllers/oidc.ts`; `docs/architecture/identity.md:5-28` |
| Agent mTLS | Hashed single-use join token, CSR proof of possession and fixed profile, per-request DB revocation with a five-second cache, TLS tickets disabled. | `apps/server/src/agent/agent-join-service.ts`; `apps/server/src/agent/agent-authenticator.ts`; `apps/server/src/transport/secure-application.ts:216-226` |
| Audit chain | Global HMAC chain, transaction-scoped advisory lock, checkpoints, fail-closed writes, stable reason codes. | `apps/server/src/audit/audit-writer.ts`; `apps/server/src/audit/audit-verify.ts` |
| Backup archive | Age passphrase encryption, checksum manifest, keyring/CA preflight, `0600` output, bounded archive size. | `apps/server/src/ops/archive.ts`; `apps/server/src/ops/backup.ts` |
| Reference Compose stack | The proxy CIDR is pinned, only 443 is published, services are non-root, and networks are split. | `deploy/compose/compose.yaml:24-163`, `:264-278` |

## Simplify / keep / reconsider

| Decision | Recommendation | Reason |
|---|---|---|
| Envelope v2 and AAD | **Keep** | The construction is correct and well tested; changing it adds risk without a security gain. |
| `__Host-` session, CSRF, exact-origin check | **Keep** | The main controls are sound. The only change is the ten-second rotation receipt and the path-based CLI exemption. |
| OIDC PKCE, state, nonce, binding | **Keep** | The flow is correctly built. Add the missing link path. |
| Agent fixed certificate profile | **Keep** | The profile is tight and the issuance path rejects CSRs with extensions. Add a second factor for key-changing renewal. |
| Audit HMAC chain | **Keep** | The chain is sound. Do not report an empty chain as `ok`; narrow the claim. |
| KEK rotation | **Reconsider** | Stop-the-world is not enforced. Use an online dual-key/epoch design or an explicit `--retire-old`; never delete the old key automatically. |
| Restore | **Reconsider** | Verify before publish, add an anti-rollback anchor, and attribute the operation to an operator with the archive hash. |
| CA lifecycle | **Reconsider** | Add CA rotation or declare CA compromise unrecoverable. The current runbook is not executable. |
| Production gate | **Simplify** | Replace the Markdown parser with one signed JSON approval bound to commit and digest. Remove the production dispatch path. Scan before tagging. |
| Admin listener | **Reconsider** | Fail closed on the broad default and bind to a dedicated interface. |
| Documentation | **Simplify** | Make one source of truth. `crypto.md`, `release-process.md`, and `backup-restore.md` currently disagree with the code. |

## Accepted v0.1 limitations versus real flaws

| Limitation | Accepted? | Still a finding? |
|---|---|---|
| Memory sessions and OIDC state; single node | Yes | No. It is explicitly single-node and documented. The CLI/agent state is in PostgreSQL. |
| No HSM; host root can read the KEK and memory | Yes | No. Out of scope for v0.1. |
| No audit prevention against a full database-admin wipe | Yes, but the API still says `ok` | AC-09. The limitation is real; the trust signal is misleading. |
| A stolen agent certificate is service-scoped until revoked | Yes, but renewal extends it | AC-07. The control is weaker than the threat row implies. |
| KEK rotation needs a maintenance window | Documented, but not enforced | AC-02. A documented precondition is not a safety property. |
| Restore verifies after commit | Documented, but no durable marker | AC-03. The failure is visible to the operator but not to the next start. |
| No CA rotation | Not documented as accepted; the runbook implies it exists | AC-13. This is a missing capability, not an accepted limitation. |
| Database-only backups/PITR after rotation | Not explicitly prohibited | AC-15. The product archive is safe; the separate-dump path is not. |

## Final verdict

Critical: 0
High: 2
Medium: 11
Low: 6

## Next steps

| Action | Owner |
|---|---|
| Fix AC-01 and AC-02 before any production label; treat both as release blockers. | Server/security |
| Add the restore verification marker, anti-rollback check, and operator/archive attribution (AC-03, AC-04). | Operations |
| Decide CA rotation scope: implement `ov ca rotate` or declare CA compromise unrecoverable and remove the runbook claim (AC-13). | Architecture |
| Bind the production gate to a commit and digest, verify tag signatures, and scan before tagging (AC-10, AC-11, AC-14). | Release |
| Add tests for two KEK rotations, a concurrent writer during rotation, a failed post-restore verification, and the release-gate formats. | QA/security |
| Align `crypto.md`, `release-process.md`, `backup-restore.md`, and `limitations.md` with the implementation (AC-12, AC-13, AC-15). | Documentation |
