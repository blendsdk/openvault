# Discovery Notes — openvault-v0-1

> Draft. Not a requirement document. The Zero-Ambiguity Gate is open until the register is resolved.

## Vision

OpenVault is a self-hosted secret and certificate store for Docker Compose projects on one
host. It versions values, grants narrow access, delivers secrets through a per-service agent,
and records every read in a tamper-evident audit log. It is Azure Key Vault-inspired but has
its own API and UX, and is built on BlendSDK v5.

## Confirmed technology

| Concern | Decision |
|---|---|
| Language / runtime | TypeScript 7.0.2, Node.js 22.23+, ESM |
| Package manager | pnpm 12.11.2 |
| Backend | BlendSDK v5 `blendsdk/webafx`, `blendsdk/postgresql` |
| Database | PostgreSQL 16/17 |
| UI | React 19, Fluent UI v9, `@blendsdk/fluentui-react-components` 0.6.0, `blendsdk/react`, Vite 8 |
| Lint / format | Biome 2.6.4 (typescript-eslint does not support TS 7) |
| Deployment | Docker Compose, one host |
| Docs | VitePress 1.6.4 on GitHub Pages |
| Auth | Unified BFF session for local + OIDC; CLI JWT; agent mTLS |
| Workload identity | One service identity per Compose service, single-use join token, 30-day mTLS cert |

## Stakeholders

| # | Role | Needs |
|---|---|---|
| 1 | Platform operator | Install, back up, rotate keys, manage projects/identities, investigate incidents |
| 2 | Application developer | Store a secret, grant a Compose service access, deliver it, rotate it |
| 3 | Security reviewer / auditor | See who can read what, review denials, verify the audit chain |
| 4 | Service identity | Authenticate without a human, read only its project's secrets |
| 5 | Contributor | Build, test, and document without private context |

## Comparable systems

| System | Relevant idea |
|---|---|
| Azure Key Vault | Secrets, certificates, keys, RBAC, soft delete, purge protection, audit, private endpoints |
| HashiCorp Vault / OpenBao | Dynamic credentials, leases, transit, policies, audit devices, agent injector |
| AWS Secrets Manager | Versioned secrets, rotation, resource policies, KMS |
| Infisical | Developer UX, project scopes, CLI, secret references, self-hosting |
| Docker secrets | Per-service file delivery, tmpfs, simple compose integration |
| SOPS + age | Encrypted files in Git, key custody, simple local workflow |

## Feature candidates

Status is the working recommendation, not yet a user decision.

| # | Feature | Recommendation |
|---|---|---|
| C1 | Versioned secrets with soft delete | Want |
| C2 | Opt-in purge protection | Want |
| C3 | Certificate import, self-signed generation, expiry | Want |
| C4 | Scoped RBAC (org/project/object) | Want |
| C5 | Hash-chained audit and verify | Want |
| C6 | Per-service agent with tmpfs delivery | Want |
| C7 | Local + OIDC BFF login | Want |
| C8 | CLI with scaffold and `run --` | Want |
| C9 | Minimal web UI | Want |
| C10 | Backup and restore with keyring | Want |
| C11 | KEK rotation | Want |
| C12 | Agent consumer metadata | Want |
| C13 | Binary secrets | Want |
| C14 | Dynamic database/cloud credentials | Skip v0.1 |
| C15 | Leases / TTL credentials | Skip v0.1 |
| C16 | HSM-backed non-exportable keys | Skip v0.1 |
| C17 | ACME / public CA issuance | Skip v0.1 |
| C18 | Kubernetes / CSI driver | Skip v0.1 |
| C19 | Remote Docker hosts | Skip v0.1 |
| C20 | Multi-tenant SaaS | Skip v0.1 |
| C21 | SCIM / SIEM export | Skip v0.1 |
| C22 | Secret scanning / approval workflows | Skip v0.1 |
| C23 | Two-person rule for purge or private-key read | Skip v0.1 |
| C24 | Explicit deny rules | Skip v0.1 |
| C25 | Break-glass recovery | Want (documented offline procedure) |
| C26 | Certificate UI | Skip v0.1 (v0.2) |
| C27 | OIDC login for CLI | Skip v0.1 (v0.2) |
| C28 | Redis session store | Skip v0.1 (v0.2) |
| C29 | Metrics / OpenTelemetry | Skip v0.1 |
| C30 | Image signing, SBOM, provenance | Want |

## User journeys

1. Operator installs the Compose stack, runs `ov init`, logs in, creates a project.
2. Developer stores a secret and scaffolds a service with `ov docker scaffold`.
3. Agent joins with a single-use token, fetches only its manifest, writes tmpfs files.
4. Application starts only after the agent is healthy; it has no vault route.
5. Operator rotates a secret; the agent refreshes.
6. Auditor runs `ov audit verify` and `ov access explain`.
7. Incident: revoke the identity; the agent removes files and exits.
8. Backup: export encrypted DB + keyring; restore into a fresh stack; verify chain.

## Edge cases and failure scenarios

| # | Scenario | Question |
|---|---|---|
| E1 | Database unavailable | Do agents keep last-known-good and degrade? |
| E2 | Keyring lost or corrupted | Startup fails closed; no recovery without backup? |
| E3 | Agent revoked | Remove files and exit immediately? |
| E4 | Cross-project tmpfs access | Per-service directory with `0700`; test with a second UID |
| E5 | Expired agent certificate | Fail closed; renew before expiry |
| E6 | KEK rotation in progress | Old and new keys both available; values not re-encrypted |
| E7 | Audit row edited or truncated | Verify reports the first bad event; checkpoints detect truncation |
| E8 | Concurrent secret writes | Immutable versions; last write wins for `latest`; idempotency key |
| E9 | Empty secret value | Reject at the API or support it with an authenticated empty ciphertext? |
| E10 | Huge secret / certificate | Enforce 64 KiB / 128 KiB limits before parsing |
| E11 | Unicode / path traversal names | Strict allowlist; reject `/`, `..`, control chars, look-alikes |
| E12 | Clock skew | Token and certificate validation fails; document NTP |
| E13 | Disk full | Writes fail; reads fail when Postgres stops; alert |
| E14 | OIDC provider down | Local admin login still works; existing sessions continue |
| E15 | Browser session store restart | Users re-login; no secret loss |
| E16 | Proxy spoofing | Trust only the proxy CIDR; test `X-Forwarded-For` |
| E17 | CSRF / XSS | CSRF token + origin checks; strict CSP; no tokens in JS |
| E18 | Rate-limit abuse | Per-IP and per-account limits; Argon2 cost budget |
| E19 | Backup restore | Encrypted archive with keyring; audit chain verifies |
| E20 | Purging a protected secret | Reject; protection cannot be disabled |
| E21 | Certificate private key read | Separate permission; audited as sensitive |
| E22 | Agent local socket abuse | Only manifest entries; same-container access only |
| E23 | Environment export leakage | Wrapper mode only; documented; files preferred |
| E24 | Consumer metadata spoofing | Bound to the authenticated service identity |

## Scope confirmation (working proposal)

### In scope for v0.1

- Secrets: create, read, version, tags, soft delete, recover, opt-in purge protection, expiry,
  idempotency, 64 KiB limit.
- Certificates: import, self-signed generation, public/private read split, expiry, lifecycle.
- Auth: local password, OIDC BFF, unified session, CSRF, CLI JWT, agent mTLS.
- RBAC: 25 actions, 9 roles, org/project/object scopes, capability flags, no escalation.
- Audit: every decision, hash chain, HMAC, checkpoints, verify, query, export, retention.
- Agent: one per service, manifest, tmpfs, atomic writes, refresh, status, local socket,
  consumer metadata, wrapper mode.
- CLI: init, login, projects, secrets, certificates, identities, roles, audit, docker
  scaffold, run, backup/restore, KEK rotate.
- UI: login, projects, secrets (masked reveal, consumers), permissions, audit.
- Ops: Compose same host, networks, Postgres, backup/restore, KEK rotation, health/readiness,
  structured logs, non-root containers.
- Security: threat model, spec tests, security tests, image signing/SBOM, external review.

### Out of scope for v0.1

- Dynamic credentials, leases, HSM, ACME, Kubernetes, remote hosts, multi-tenant, SCIM/SIEM,
  approval workflows, two-person rule, explicit deny, certificate UI, OIDC CLI, Redis, metrics.

## Open decisions

| # | Decision | Recommendation |
|---|---|---|
| Q1 | Feature boundary | One feature `openvault-v0-1` for the release |
| Q2 | Transport | Separate admin listener behind proxy and agent mTLS listener |
| Q3 | Crypto | Keep AES-GCM primitive; rewrite keyring/AAD API |
| Q4 | Server | Rebuild the security spine; keep workspace and UI shell |
| Q5 | Repo | Public source, private advisories, no image until gates |
| Q6 | External review | Required before v0.1 |
| Q7 | Empty secret value | Reject empty values at the API; crypto core supports empty ciphertext for completeness |
| Q8 | Binary secrets | Support with explicit `encoding: base64` |
| Q9 | Soft delete / audit retention | 30 days / 180 days, configurable |
| Q10 | Backup RPO/RTO | 24 h / 1 h |
| Q11 | Session store | Memory in v0.1; Redis v0.2 |
| Q12 | Break-glass recovery | Documented offline keyring recovery, no second admin bypass |
| Q13 | Rate limits | 5/min login per IP, 10/h per account, 10/min join, 600/min data |
| Q14 | Argon2id | 64 MiB, 3 iterations, 1 lane |
| Q15 | Agent / Compose mapping | OpenVault project is a namespace; Compose project is a consumer label |
| Q16 | Repo/agent review safety | Reviewers read-only; pin/vendor installer |
| Q17 | CodeOps gates | Security-auditor on auth/crypto/agent/deploy; two reviewers for crypto |
| Q18 | External review scope | Independent review of crypto, auth, agent isolation, deploy |
