# OpenVault — Requirements Documents

> **Project**: OpenVault — self-hosted secret and certificate store for Docker Compose
> **Status**: Draft for review
> **Created**: 2026-10-29
> **Architecture**: TypeScript 7 / BlendSDK v5 WebAFX / PostgreSQL 16/17 / React 19 + Fluent UI v9 / Docker Compose
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault stores secrets and certificates for Docker Compose projects on one host. It
versions values, grants narrow access, delivers secrets through a per-service agent, and
records every read in a tamper-evident audit log. It is Azure Key Vault-inspired but has
its own API, CLI, and UI.

The v0.1 release targets a small team running real workloads on one Docker host. It
prioritizes least privilege, fail-closed behavior, and defensible evidence over feature
breadth. The security-critical surfaces are covered by specification tests and independent
review before any production-labelled release.

## Minimum-Sufficient Baseline

**Original goal:** a self-hosted secret and certificate store for Docker Compose projects
that does not leak data and can be operated safely by a small team.

**Smallest viable design:** one Compose stack, PostgreSQL, WebAFX API + UI, one agent per
Compose service, per-service tmpfs delivery, mTLS workload identity, scoped RBAC, and a
hash-chained audit log. No Kubernetes, remote hosts, HSM, ACME, or dynamic credentials in
v0.1.

**Excluded support machinery:** multi-arch releases, Redis sessions, Kubernetes/CSI, external
KMS/HSM, ACME, multi-tenant isolation, SCIM/SIEM export, metrics/OTel, approval workflows,
two-person rule, explicit deny rules, certificate UI, and OIDC CLI login.

**Approved complexity:** AR-7 and AR-23 — a scoped independent external review at release
candidate, and a signed amd64 release pipeline with SBOM, Trivy/Grype scan plus scheduled
rescan, provenance, SHA-pinned actions, and mandatory security-auditor gates.

## Domain lenses

| Lens | Evidence |
|---|---|
| Web application | Browser UI, HTTP API, sessions, project/object scopes |
| Data and migration | Persistent schema, ciphertext, versioning, retention, migrations, backups |
| Distributed and concurrent | Agents, concurrent writes, audit chain ordering, key rotation, session rotation |

Specialist check: security, data integrity, and concurrency are material. The project uses
`security-auditor`, `correctness-reviewer`, `concurrency-auditor`, `design-challenger`, and
`preflight-auditor` on the phases that touch those risks.

## Domain Glossary

| Term | Definition |
|---|---|
| OpenVault project | Namespace for secrets, certificates, identities, and role assignments |
| Compose project | A Docker Compose project; a consumer label, not an authorization boundary by itself |
| Service | One container in a Compose project |
| Principal | A human user or a service identity |
| Service identity | A non-human principal owned by exactly one OpenVault project |
| Action | A fixed permission string such as `secret.read` |
| Role | A fixed set of actions |
| Scope | Organization, project, or single object |
| Assignment | A role granted to a principal at a scope |
| Secret | Named object with one or more immutable versions |
| Version | Immutable value of a secret or certificate |
| Certificate | A chain plus an encrypted private key, with metadata and expiry |
| Agent | Sidecar that fetches one service's secrets and writes them to tmpfs |
| Consumer | Agent registration with Compose project, service, hostname, and manifest hash |
| Join token | Single-use, short-lived token exchanged for an agent client certificate |
| KEK | Key encryption key; wraps data keys and lives outside PostgreSQL |
| DEK | Data encryption key; encrypts one version's value |
| Envelope | Ciphertext, nonce, tag, wrapped DEK, wrap nonce, wrap tag, KEK id |
| Audit chain | Append-only, hash-chained, HMAC-protected event sequence |
| BFF | Backend-for-frontend; the server owns the browser session and OIDC flow |
| Admin listener | TLS listener reachable only from the proxy |
| Agent listener | mTLS listener reachable only by agents |
| Capability | Per-object boolean such as `canRead` returned by the API |
| Break-glass | Documented offline recovery using the keyring and a backup |
| RPO / RTO | Recovery point objective / recovery time objective |

## Document Index

| # | Document | Description | Depends On |
|---|---|---|---|
| **AR** | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions | — |
| **RD-01** | [Foundation, Data Model, and Build Security](RD-01-foundation-data-build.md) | Workspace, schema, migrations, build and CI security | — |
| **RD-02** | [Transport, Configuration, and Readiness](RD-02-transport-config-readiness.md) | Typed boot config, two TLS listeners, proxy trust, readiness | RD-01 |
| **RD-03** | [Human Authentication and Sessions](RD-03-human-auth-sessions.md) | Local password, OIDC BFF, sessions, CSRF, rate limits | RD-02 |
| **RD-04** | [CLI Authentication](RD-04-cli-auth.md) | JWT access and rotating refresh tokens | RD-03 |
| **RD-05** | [Service Identities and mTLS](RD-05-service-identities-mtls.md) | Service identities, join tokens, CA, certs, revocation | RD-02, RD-03 |
| **RD-06** | [RBAC](RD-06-rbac.md) | Actions, roles, scopes, assignments, capability flags | RD-03, RD-05 |
| **RD-07** | [Audit](RD-07-audit.md) | Event chain, HMAC, checkpoints, verify, export, retention | RD-02, RD-03, RD-06 |
| **RD-08** | [Projects and Secrets](RD-08-projects-secrets.md) | Secret lifecycle, versions, limits, idempotency, consumers | RD-06, RD-07 |
| **RD-09** | [Certificates](RD-09-certificates.md) | Import, self-signed generation, private-key split, expiry | RD-08 |
| **RD-10** | [Agent Delivery and Compose](RD-10-agent-compose.md) | Per-service agent, tmpfs, refresh, local API, scaffold | RD-05, RD-07, RD-08 |
| **RD-11** | [CLI](RD-11-cli.md) | Command groups, `run --`, JSON, generated client | RD-04, RD-06, RD-08, RD-09, RD-10 |
| **RD-12** | [Web UI](RD-12-web-ui.md) | Login, projects, secrets, permissions, audit, accessibility | RD-03, RD-06, RD-08, RD-10 |
| **RD-13** | [Backup, Rotation, and Operations](RD-13-backup-rotation-ops.md) | Encrypted backup, restore, rewrap, deployment, logs | RD-02, RD-08, RD-09 |
| **RD-14** | [Security Assurance and Release](RD-14-security-release.md) | Threat-model tests, reviews, signed image, SBOM, scan | All |

## Dependency Graph

```text
RD-01 (Foundation, schema, build security)
  └── RD-02 (Transport, config, readiness)
        ├── RD-03 (Human auth, sessions)
        │     ├── RD-04 (CLI auth)
        │     └── RD-05 (Service identities, mTLS)
        │           └── RD-06 (RBAC)
        │                 ├── RD-07 (Audit)
        │                 │     ├── RD-08 (Projects, secrets)
        │                 │     │     ├── RD-09 (Certificates)
        │                 │     │     └── RD-10 (Agent, Compose)
        │                 │     │           ├── RD-11 (CLI)
        │                 │     │           └── RD-12 (Web UI)
        │                 │     └── RD-13 (Backup, rotation, ops)
        │                 └── RD-14 (Security assurance, release)
```

## Suggested Implementation Order

| Phase | Documents | Description |
|---|---|---|
| **A: Foundation** | RD-01, RD-02 | Workspace, schema, typed config, two listeners, readiness |
| **B: Identity** | RD-03, RD-04, RD-05, RD-06 | Human auth, CLI auth, service identities, RBAC |
| **C: Core data** | RD-07, RD-08, RD-09 | Audit, secrets, certificates |
| **D: Delivery** | RD-10, RD-11 | Agent, Compose scaffold, CLI |
| **E: Experience** | RD-12, RD-13 | Web UI, backup/rotation/ops |
| **F: Release** | RD-14 | Security assurance, external review, signed image |

## Key Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| API | Own Azure-inspired REST API | Clean UX; no Azure compatibility tax |
| HTTP framework | BlendSDK v5 WebAFX | Controllers, validation, security middleware, lifecycle |
| Database | PostgreSQL with named-parameter SQL | Transactions, audit ordering, no ORM |
| Crypto | AES-256-GCM envelope with per-version DEK | Sound primitive; keyring outside DB |
| Workload identity | mTLS certificates via single-use join tokens | No static API keys |
| Browser auth | Unified BFF session for local + OIDC | No tokens in JavaScript; local users can use the UI |
| Sessions | In-memory cache in v0.1 | No Redis; no token at rest |
| Agent model | One agent per Compose service | Least privilege and per-service tmpfs |
| RBAC | Deny-by-default, allow-only, three scopes | Simple to test; no explicit deny in v0.1 |
| Audit | Synchronous, hash-chained, fail closed | A read without evidence is a defect |
| Transport | Admin listener behind proxy + agent mTLS listener | No shared cleartext bridge |
| Release | Signed amd64 image, SBOM, scan, provenance | Image is the trust root |

## How to Use These Documents

1. Review and approve the RD set.
2. Run `make-plan` for RD-01, then `preflight`.
3. Implement only accepted plan tasks, with `*.spec.test.ts` written first.
4. Run `security-auditor` and `correctness-reviewer` at each phase gate.
5. Do not publish an image or store real secrets until RD-14 is satisfied.
