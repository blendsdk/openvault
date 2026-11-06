# Threat model

> **Evidence**: every threat row below is mapped to automated tests or a
> documented manual check in the [security evidence matrix](evidence-matrix.md).
> The matrix is checked by `pnpm security:evidence:check`.

## Assets

| Asset | Sensitivity |
|---|---|
| Secret values | Highest |
| Certificate private keys | Highest |
| Key encryption key | Highest |
| Workload private keys | High |
| Browser and CLI credentials | High |
| Audit log and checkpoints | High (integrity) |
| Policy and assignments | Medium (integrity) |
| Metadata | Medium |

## Trust boundaries

- **B1** Human to API: untrusted network to Caddy, then proxy-only TLS to the admin
  listener. The admin listener is on a dedicated `admin_net` and rejects peers outside
  `OPENVAULT_PROXY_CIDRS`; loopback may only call `/health` and `/ready`.
- **B2** Agent to API: mTLS on a separate `vault_net` listener; the server verifies the
  client certificate against the internal CA.
- **B3** API to database: internal `db_net`, but the database may be dumped.
- **B4** API to keyring: absolute file with exact mode `0600`.
- **B5** Agent to application: per-service tmpfs; the app reads only its own files.
- **B6** Build to release: source, pinned actions, SBOM, scan, signature, and provenance.

## Adversaries

| Adversary | Outcome |
|---|---|
| Network attacker | TLS and mTLS prevent reading or impersonation |
| Compromised app container | Reads only its mounted secrets; other services and projects are out of reach; reads are audited |
| Compromised sibling service | Cannot read this service's tmpfs directory |
| Stolen backup | Ciphertext only; the keyring is inside the age-encrypted archive and the passphrase is stored separately |
| Database dump | Ciphertext, wrapped keys, policy, audit chain; no plaintext |
| Limited insider | Only the actions granted to the role; every action audited |
| Stolen agent certificate | Service-scoped access until revoked |
| Supply-chain attacker | Full-SHA action pins, pinned base images, Trivy, SBOM, Cosign, and provenance |
| Host root | Can read the KEK, tmpfs, and plaintext memory; out of scope for v0.1 |

## Threats and protections

| ID | Threat | Protection |
|---|---|---|
| T-01 | A network attacker intercepts admin, browser, or agent traffic | TLS 1.2+, HSTS, a separate mTLS agent listener, and a proxy-only admin listener |
| T-02 | Credential stuffing or password guessing against a local account | Argon2id, per-address and per-account limits, lockout, and a generic failure response |
| T-03 | A stolen browser session cookie is replayed | Host-scoped HttpOnly Secure SameSite cookie, CSRF token, rotation, and absolute expiry |
| T-04 | A cross-site request performs a state change with the user's cookie | Origin and Fetch Metadata checks plus a per-session CSRF header on every unsafe method |
| T-05 | A stolen CLI access or refresh token is replayed | Short-lived JWTs and rotating refresh tokens with reuse detection and family revocation |
| T-06 | A principal performs an action outside its role, scope, or project | Deny-by-default RBAC with org, project, and object scopes and capability flags |
| T-07 | A service identity reaches control-plane actions | A service ceiling in the policy engine rejects control-plane actions even with a forged assignment |
| T-08 | A compromised workload reads another project's delivered files | Per-project and per-service host directories, a manifest that cannot change project or root, and a read-only application mount |
| T-09 | A stolen agent certificate is used after revocation | Atomic identity revocation, certificate invalidation, listener cache invalidation, and files removed on 401/403 |
| T-10 | A database dump exposes secret or certificate plaintext | AES-256-GCM envelope encryption with a KEK outside the database and per-object AAD |
| T-11 | A stolen backup exposes plaintext or is silently corrupted | An age passphrase archive with a checksum manifest and a preflight keyring check |
| T-12 | The keyring is read, replaced, or serialized into a log | Absolute path, exact 0600, no symlinks, status-only serialization, and redacted logs |
| T-13 | An attacker edits, deletes, or truncates the audit chain | Hash chain, HMAC, checkpoints, and verification that reports the first broken event |
| T-14 | A secret, token, CSR, or key is written to a log | Pino path redaction, request URL sanitization, and agent event-only logging |
| T-15 | Injection or path traversal reaches SQL, the filesystem, or a route | Parameterized SQL, strict schemas, canonical paths, and malformed-encoding rejection |
| T-16 | An oversized or malformed body exhausts memory or bypasses a limit | Body limits, decoded-value limits, and bounded CSR and certificate envelopes |
| T-17 | A flood or repeated request bypasses a rate limit | Per-IP, per-account, per-principal, per-family, and per-route buckets with bounded state |
| T-18 | A container escapes its intended privileges or reaches the Docker socket | Non-root users, read-only roots, capability drops, no-new-privileges, resource limits, and no socket mount |
| T-19 | A browser secret value leaks into storage, the URL, or the console | Reveal lives only in component state, clears on blur/navigation/timeout, and is never stored |
| T-20 | The admin listener is reachable without the proxy or health source guard | Proxy CIDR allowlist, loopback-only health and readiness, and no published admin port |

## Accepted risks

- Node cannot reliably zeroize strings.
- A compromised application can read every secret mounted into it.
- Host root and swap can expose the KEK and tmpfs.
- A database administrator can truncate the audit table; only an exported checkpoint
  proves it.
- Single-node deployment has no high availability.
- Browser sessions are lost on restart.
- No explicit deny rules in v0.1.
- The readiness timeout bounds the response, not an in-flight database query; the pool
  connection timeout and connection cap bound the residual work.
- The independent external review is pending; a production-labelled image is blocked
  until it is approved. Alpha images are explicitly not for production.

See [Known limitations](/security/limitations) and the
[incident response runbook](incident-response.md).
