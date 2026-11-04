# Changelog

## 0.1.0 — in development

### Added

- pnpm 12 workspace with TypeScript 7.0.2 and Biome 2.6.4.
- Envelope-encryption core with per-version data keys, AAD binding, and tests.
- WebAFX server skeleton with `GET /v1/ready` and `GET /health`.
- React 19 + Fluent UI v9 web shell using `@blendsdk/fluentui-react-components` and
  `blendsdk/react`.
- VitePress documentation site with GitHub Pages deployment.
- CI, CodeQL, dependency review, and secret-scan workflows.
- Server-side service identities, administrative lifecycle, join-token issuance, CA/X.509
  agent join and renewal, mTLS agent listener, revocation, bounded retention, and CA
  readiness.
- Local and OIDC browser authentication plus CLI bearer authentication.
- Scoped RBAC with fixed actions and roles, assignment administration, grant guards,
  policy-side capability computation, and access explanations.
- Append-only audit chain with canonical hashing, a KEK-wrapped HMAC key, checkpoints,
  cursor-paginated query, chain verification, NDJSON export, and explicit retention pruning.
- Audit evidence for authorization, assignments, identity, local/CLI/OIDC authentication,
  lockouts, agent join/renew, and consumer metadata changes.
- Project lifecycle and versioned secrets with AES-256-GCM envelopes, object-type AAD,
  tags, content types, expiry, idempotent writes, capability flags, consumer summaries,
  soft delete, recovery, one-way purge protection, and a dedicated purge credential.
- Canonical value encoding, a 64 KiB decoded limit, and a 512 KiB data-route body guard.
- Certificate import and self-signed generation with strict PEM/PKCS#8 validation, key/chain
  checks, immutable versions, public-chain and private-key reads, expiry 410 behavior, tags,
  search, capabilities, soft delete, recovery, one-way protection, and guarded purge.
- Certificate expiry warnings at 30/14/7 days, durable per-threshold claims, an optional
  timestamped-HMAC webhook, and certificate expiry audit events.
- A project list certificate count for the UI.

### Planned

- `ov-agent` client with tmpfs delivery and local status socket.
- CLI and Docker Compose scaffold.
- Minimal web UI.
