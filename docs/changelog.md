# Changelog

## 0.1.0 — in development

### Added

- pnpm 12 workspace with TypeScript 7.0.2 and Biome 2.6.4.
- Envelope-encryption core with per-version data keys, AAD binding, and tests.
- WebAFX server skeleton with `GET /v1/ready` and `GET /health`.
- React 19 + Fluent UI v9 web UI using `@blendsdk/fluentui-react-components` and
  `blendsdk/react`: local/OIDC login, projects, secrets with audited masked reveal, identities,
  permissions, audit search/verification, consumers, dark mode, and responsive navigation.
- Application-shell polish: the BlendSDK `AppLauncher` for global and project navigation with
  search, a vault-dial brand mark and favicon, and consistent vertical spacing for page
  headers and descriptions.
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
- `ov-agent`: manifest-driven tmpfs delivery, mTLS join and renewal, atomic writes, refresh
  failure handling, a read-only unix socket, a value-free status file, health/readiness exit
  codes, `--once`, and opt-in wrapper mode.
- Per-fetch consumer state headers and an aggregate heartbeat route; state transitions write
  `consumer.update` audit events.
- `POST /v1/admin/scaffold`: idempotent project/identity reuse, object-scope reader grants,
  atomic join-token rotation, and per-service Compose and manifest output.
- `ov` CLI: bootstrap, login/logout/whoami, CLI sessions, projects, versioned secrets,
  certificates, identities, roles, access explanation, audit query/verify/export, Docker
  scaffold, `run --`, doctor, and static shell completion.
- Generated CLI API contract: `packages/api-contract/openapi.json` and a typed client in
  `apps/cli/src/generated`, with `pnpm api:check` drift detection in `pnpm verify`.
- Protected CLI credential storage with `0700`/`0600` checks, atomic replacement, symlink
  rejection, a cross-process lock, and native-Windows fail-closed behavior.
- Shared bootstrap `ov init`: idempotent keyring, internal CA, server certificate,
  organization, administrator, and signing-key creation; recovery guard for a missing keyring;
  one-time bootstrap password file.
- CLI `run` delivery through a private temporary directory, a strict manifest, environment
  sanitization, signal forwarding, and cleanup on every exit path.
- `pnpm api:generate` / `pnpm api:check`, plus OpenAPI/Architecture/CLI documentation.
- `ov backup` / `ov restore`: passphrase-encrypted age archives containing a logical database
  dump, keyring, redacted config, public CA, and audit checkpoints; checksum verification,
  empty-target safety, audit-chain and secret/CA verification on restore.
- `ov kek rotate`: rewrap of secret and certificate data keys, audit keys, CA keys, and JWT
  seeds with byte-identical value ciphertext; old-key removal only after a full `kek_id` check.
- New `backup.restore` audit action and `@openvault/server/ops` package surface.
- Generated browser API client and WebAFX production static serving with hashed-asset caching,
  SPA fallback, and a UI-enabled same-origin CSP.
- Web UI tests: component behavior, storage/URL/console leak checks, CSRF strategy, and axe on
  login, secret detail, and audit.
- Restore verification of a pre-backup agent certificate with `--agent-certificate`, plus the
  restore drill and agent-certificate negative test.
- `OPENVAULT_*_DB_URL_FILE` support for Docker secrets, a separate startup migrator URL, and
  least-privilege `openvault_migrator`, `openvault_app`, `openvault_purger`, and
  `openvault_pruner` roles with an ownership assertion.
- Hardened four-service Compose stack: non-root users, read-only roots, capability drops,
  no-new-privileges, resource limits, log rotation, Docker secrets, internal networks, and a
  static web container. `pnpm check:compose` enforces the contract.
- Disposable local review environment (`deploy/compose/review.sh`): loopback-only proxy,
  local TLS, ownership setup through Docker, synthetic projects and secrets, a signed-in CLI
  shell, and guarded reset.
- Server, agent, and web Dockerfiles with digest-pinned base images.
- `ov doctor` database, keyring, TLS, clock, and 24-hour backup-age checks.
- `ov audit checkpoint --out` and systemd timers for daily encrypted backup and off-box
  checkpoint export.
- Threat-model-to-test evidence matrix, security-claims ledger, and generated documentation
  pages checked by `pnpm verify`.
- Release workflow: amd64 build, BuildKit SBOM/provenance, Trivy HIGH/CRITICAL gate, Cosign
  keyless signing, signature verification, GitHub release assets, and an alpha-only manual
  mode labelled not for production.
- Weekly dependency audit and container rescan workflow.
- Incident response runbook, release process, branch-protection evidence, external-review
  packet, and a fail-closed production-label gate.

### Deferred

- The independent external review is pending; a production-labelled image is blocked until it
  is approved.
- Multi-arch images, certificate screens, and real-browser Playwright checks across engines;
  v0.1 keeps certificates in the CLI and runs axe in jsdom.
