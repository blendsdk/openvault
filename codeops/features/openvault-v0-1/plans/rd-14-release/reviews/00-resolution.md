# Review findings resolution

> **Date**: 2026-11-06
> **Scope**: RD-13 and RD-14 working tree
> **Rule**: every Critical and High finding is fixed before merge; accepted Medium/Low findings have an explicit reason.

## High findings

| Finding | Status | Resolution |
|---|---|---|
| SEC-01 browser login/password-change race | Fixed | The browser login now creates the session first and revalidates the credential hash afterwards. On mismatch it revokes the new session. This closes both interleavings with the password-change revocation loop. |
| ADR-01 file-backed URL breaks startup migration | Fixed | `runStartupMigrations` now always supplies the explicit runtime URL when no migration URL is configured. A file-backed-only configuration is covered by the config test. |
| AC-01 broad default proxy CIDR | Fixed | The default is now loopback only. A production proxy on another container must set the CIDR explicitly; forgetting it fails closed on availability. |
| AC-02 KEK rotation with a live server | Fixed | Rotation refuses while an `openvault_app` session is connected; KEK identifiers are random and never reused. The ops integration test holds an app connection and asserts the refusal. |

The two independent reports both recorded `High: 1`; the design challenge recorded
`High: 2` (AC-01 and AC-02). All four distinct High findings are fixed.

## Medium findings

| Finding | Status | Resolution or accepted reason |
|---|---|---|
| SEC-02 browser refresh retry receipt | Accepted | Ten-second receipt is a retry aid. Claims and limitations now say so; CLI reuse detection remains strict. |
| SEC-03 runtime migrator credential | Fixed | Compose sets `OPENVAULT_RUN_MIGRATIONS=false`; `openvaultd` no longer mounts the migrator secret. Init runs migrations with the owner role. |
| SEC-04 sampled restore verification | Fixed | Preflight and post-restore verification now decrypt every current secret, every current certificate private key, all audit/CA/signing wrapped keys, and sign/verify a JWT probe. |
| SEC-05 prune evidence ordering | Accepted | The boundary checkpoint is written before the delete and remains if the completion event fails. A start event would need a schema change; tracked for the next release. |
| SEC-06 bootstrap must-change contradiction | Fixed | Documentation now states the bootstrap exception; the one-time file moved to a separate `bootstrap` directory that the runtime container does not mount. |
| ADR-02 TLS signature verification | Fixed | Runtime and init now verify the leaf signature and exact SANs. Readiness still uses a liveness-only healthcheck, but startup refuses a mismatched CA. |
| ADR-03 broad runtime key-table DML | Partly fixed | App can no longer insert/update/delete `ca_keys`, update/delete `audit_keys`, or delete `signing_keys`. The app still updates signing-key status for rotation and principal/certificate revocation state; those are required runtime DML and are recorded as residual. |
| ADR-04 credentials in process arguments | Fixed | Role init sends passwords through stdin; the grants job reads the URL into libpq environment variables instead of argv. |
| ADR-05 systemd ownership | Fixed | The install commands create the backup directory and environment file owned by the unit user. |
| ADR-06 Caddy host mismatch | Fixed | The site address is `OPENVAULT_SITE_ADDRESS`, documented next to `OPENVAULT_BASE_URL`. |
| ADR-07 lost join response | Accepted | A lost join response still needs a new token. Bounded join replay is a v0.2 item; the agent retries transient failures and fails closed on a used token. |
| ADR-08 shared host path | Fixed | Host output and state paths now include the OpenVault project, so two tenants cannot share a tmpfs or state directory. |
| ADR-09 Compose check gaps | Fixed | UID, capability allowlist, every-service port check, image form, migrator-secret absence, and negative self-tests were added. |
| ADR-10 restore lock | Fixed | `restoreDatabase` takes a session advisory lock on the target database, so concurrent restores serialize. The documented server-stop procedure still applies to application traffic. |
| AC-03 restore before verify | Partly fixed | Verification is now complete rather than sampled and records archive hash/time. Publishing still happens before verification; the documented maintenance window and non-zero exit remain the control. |
| AC-04 restore rollback freshness | Accepted | Rollback protection needs an off-box checkpoint comparison and operator attribution; documented as a residual and scheduled. |
| AC-07 stolen agent renewal | Accepted | Renewal still accepts the current certificate and a fresh key. Revocation is the control; a second factor for key-changing renewal is scheduled. |
| AC-08 OIDC link path | Accepted | No link route exists; the limitation is documented. A verified-email collision remains denied. |
| AC-09 empty audit chain | Accepted | An empty chain with no checkpoint cannot prove prior existence; the claim and threat row now say that explicitly. |
| AC-10 release gate binding | Fixed | The gate requires the reviewed commit, reviewer, release, and zero open High/Critical. Production dispatch must run from a tag. |
| AC-11 tag before scan | Fixed | Builds push a staging tag; final tags are created only after scan and signature pass. |
| AC-12 runtime TLS chain | Fixed | Runtime load and readiness verify the leaf signature and service name. |
| AC-13 CA rotation | Accepted | No online CA rotation exists. The incident runbook now declares CA compromise a fresh-deployment procedure. |
| AC-14 approval parser | Fixed | The parser accepts the blockquote/bold format and has positive and negative self-tests. |
| AC-16 CA validity | Fixed | `CaSigner.load` rejects an expired or not-yet-valid CA. |
| AC-17 redaction | Fixed | `clientSecret` and `passphrase` are in the redaction paths. |
| AC-18 OIDC UserInfo precedence | Fixed | ID-token claims win; UserInfo only fills missing fields. |
| AC-19 CSRF path exemption | Fixed | The exemption is based on the authenticated context, not the path. A browser cookie on a CLI path now goes through CSRF. |

## Low findings

Low findings are either fixed in the same changes (Compose self-tests, CA validity, redaction, OIDC precedence) or recorded in `docs/security/limitations.md`. They do not block the release.
