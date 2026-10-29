# Threat model

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

- **B1** Human to API: untrusted network, TLS.
- **B2** Agent to API: mTLS with a service identity.
- **B3** API to database: trusted network, but the database may be dumped.
- **B4** API to keyring: local file with restrictive permissions.
- **B5** Agent to application: per-service tmpfs; the app reads only its own files.

## Adversaries

| Adversary | Outcome |
|---|---|
| Network attacker | TLS and mTLS prevent reading or impersonation |
| Compromised app container | Reads only its mounted secrets; other services and projects are out of reach; reads are audited |
| Compromised sibling service | Cannot read this service's tmpfs directory |
| Stolen backup | Ciphertext only; the KEK is inside an encrypted archive |
| Database dump | Ciphertext, wrapped keys, policy, audit chain; no plaintext |
| Limited insider | Only the actions granted to the role; every action audited |
| Stolen agent certificate | Service-scoped access until revoked |
| Host root | Can read the KEK, tmpfs, and plaintext memory; out of scope for v0.1 |

## Protections

| Threat | Protection |
|---|---|
| Database theft | Envelope encryption; KEK outside the database |
| Backup theft | Encrypted archive; keyring has its own passphrase |
| Traffic interception | TLS 1.2+, mTLS for workloads, HSTS |
| Credential stuffing | Argon2id, rate limits, lockout |
| Session theft | HttpOnly, Secure, SameSite cookies; rotation; 8-hour TTL |
| Token theft | Short-lived JWTs, rotating refresh tokens |
| Over-broad access | Deny-by-default RBAC, scopes, per-service agents |
| Cross-project access | Per-project/service tmpfs directories, mode `0700` |
| Silent tampering | Hash chain plus HMAC; verify endpoint |
| Log leakage | Structured logging with redaction |
| Injection | Parameterized SQL via `blendsdk/postgresql`, input validation |
| Browser token theft | OIDC tokens never reach JavaScript and are not stored |

## Accepted risks

- Node cannot reliably zeroize strings.
- A compromised application can read every secret mounted into it.
- Host root and swap can expose the KEK and tmpfs.
- A database administrator can truncate the audit table; only an exported checkpoint
  proves it.
- Single-node deployment has no high availability.
- Browser sessions are lost on restart.
- No explicit deny rules in v0.1.

See [Known limitations](/security/limitations).
