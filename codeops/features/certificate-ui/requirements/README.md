# OpenVault Certificate UI — Requirements

> **Project**: OpenVault — self-hosted secrets and certificates for Docker Compose
> **Feature**: Certificate management in the web UI
> **Status**: Draft (preflight ready)
> **Created**: 2026-11-08 16:32
> **Target Release**: v1.1.0
> **CodeOps Artifact Schema**: 1

## Overview

OpenVault's certificate API and CLI are complete, but operators cannot manage certificates from the
browser. This feature adds a Certificates section to every project with list, detail, import,
generate, renew, version read, tag and purge-protection editing, delete, recover, purge, public
material, and audited private-key access. It reuses the existing server routes, RBAC policy, audit
trail, and UI patterns. It adds no certificate authority, ACME client, new runtime dependency, or
deployment change.

## Minimum-Sufficient Baseline

**Original goal:** an operator can perform every supported certificate task in the web UI without
using the CLI, with the same permissions and audit behavior.

**Smallest viable design:** two pages, three dialogs, one generated browser client group, two
additive server list parameters (status and a broader `q`), and two additive capability flags.

**Excluded support machinery:** no new UI library, state store, data-fetching layer, notification
system, certificate authority, ACME client, upload service, or infrastructure change.

**Approved complexity:** None.

## Domain Glossary

| Term | Definition |
|---|---|
| Certificate | A named project object with immutable versions, an encrypted private key, and public leaf/chain material |
| Version | One immutable certificate and key pair; the current pointer selects the active version |
| Leaf | The end-entity certificate |
| Chain | Zero or more intermediate CA certificates between the leaf and the trust anchor |
| SAN | Subject Alternative Name, typed as `DNS:`, `IP:`, `URI:`, or `email:` |
| Purge protection | A one-way flag that prevents permanent deletion of a soft-deleted certificate |
| Purge deadline | The earliest time a soft-deleted certificate may be purged |
| Capability | A per-object boolean (`canRead`, `canWrite`, `canDelete`, `canRecover`, `canPurge`, `canManage`, `canReadPrivate`) that the UI uses to hide actions; the server remains authoritative |

## Document Index

| # | Document | Description | Depends On |
|---|----------|-------------|------------|
| **AR** | [Ambiguity Register](00-ambiguity-register.md) | Zero-Ambiguity Gate decisions (audit trail) | — |
| **RD-01** | [Certificate Management UI](RD-01-certificate-ui.md) | Requirements, scope, security, and acceptance criteria | — |

## Dependency Graph

```text
openvault-v0-1/RD-09 (Certificates)
openvault-v0-1/RD-12 (Web UI)
                 \   /
                  \ /
            certificate-ui/RD-01
                   |
          certificate-ui plan
          (rd-01-certificate-ui)
```

## Suggested Implementation Order

| Phase | Documents | Description |
|-------|-----------|-------------|
| **A: Contract** | RD-01 §API contract changes | List status filter, name/subject search, capability flags, browser client |
| **B: Shell** | RD-01 §Routes and navigation | Routes, section navigation, launcher entry, docs mapping |
| **C: Read** | RD-01 §List behavior, §Detail behavior | List, filters, detail, public material, version read |
| **D: Write** | RD-01 §Import, §Generate, §Metadata | Import, generate, renew, tags, purge protection |
| **E: Lifecycle** | RD-01 §Delete/recover/purge, §Private key | Delete, recover, purge, private-key reveal/download |
| **F: Release** | RD-01 §Integration Points | Documentation, version metadata, full verification |

## Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Feature location | New `certificate-ui` feature set, RD-01 | Keeps the closed v1.0 set intact; nested ids reset per feature |
| Transport | Generated browser client | One typed contract; no hand-written fetch layer |
| Permissions | Capability flags + server checks | UI hides actions; server authorizes every request |
| List state | Local state + `useAsync` | Matches the existing pages; no global store |
| Private key | Explicit confirmation, 60s reveal, download | Minimizes browser exposure while keeping parity |
| Release | v1.1.0 minor | New user-facing capability |

## Specialist Check

**None** — the capability-gap check found no recurring project-specific invariant beyond the
existing web, API, RBAC, and test patterns. The repository has no specialist briefs, and a dynamic
packet covers this work.

## How to Use These Documents

1. Read the [Ambiguity Register](00-ambiguity-register.md) for every resolved decision.
2. Read [RD-01](RD-01-certificate-ui.md) for behavior, scope, security, and acceptance criteria.
3. Open the implementation plan at
   [`../plans/rd-01-certificate-ui/00-index.md`](../plans/rd-01-certificate-ui/00-index.md).
4. Run preflight against the plan, then execute it with the `exec-plan` skill.
