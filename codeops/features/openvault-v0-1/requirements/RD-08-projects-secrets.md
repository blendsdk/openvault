# RD-08: Projects and Secrets

> **Document**: RD-08-projects-secrets.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-06, RD-07
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the core product object: projects and versioned secrets. It covers
creation, immutable versions, metadata, tags, soft delete, recovery, opt-in purge protection,
expiry, idempotency, binary values, size and name limits, consumer summaries, and per-object
capabilities.

## Functional Requirements

### Must Have

- [ ] Organization administrators can create, rename, and soft-delete projects; names match
  `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` and are unique.
- [ ] Soft-deleting a project hides its secrets, certificates, identities, and assignments
  immediately; audit history remains.
- [ ] Secret names match `^[A-Za-z0-9][A-Za-z0-9-]{0,126}$`.
- [ ] Secret values are limited to 64 KiB; empty and whitespace-only values are rejected at
  the API with 422.
- [ ] Every write creates an immutable version; `latest` resolves to the newest active
  version.
- [ ] Values may be UTF-8 text or base64 with explicit `encoding: base64`.
- [ ] Metadata reads list name, tags, current version, timestamps, status, and consumer
  summaries only; no value field.
- [ ] Tags are up to 15 string key/value pairs; content type defaults to `text/plain`.
- [ ] Metadata updates do not create a version.
- [ ] Soft delete retains a secret for 30 days by default (7–90 configurable); recovery
  restores the previous state.
- [ ] Purge protection is opt-in, one-way, and blocks purge permanently.
- [ ] Purge is allowed only after retention and only when protection is disabled.
- [ ] Optional version expiry returns 410 `secret_expired` for expired versions.
- [ ] Writes accept `Idempotency-Key`; a replay within 24 hours returns the original version.
- [ ] A value write and its audit event commit in one transaction.
- [ ] A secret response includes `canRead`, `canWrite`, `canDelete`, `canPurge`, and
  `canManage`.
- [ ] Secret metadata includes consumer Compose project/service names.
- [ ] Errors, lists, headers, and logs never contain values.

### Should Have

- [ ] Search and tag filtering on the secret list.
- [ ] A version diff view in the UI that shows metadata, not values.
- [ ] Scheduled expiry notifications for secret versions.

### Won't Have (Out of Scope)

- Dynamic secrets, database credential leasing, or cloud token generation.
- Secret sharing links or public access.
- Folder hierarchies inside a project.

## Technical Requirements

### Data model

```text
projects 1 ── * secrets 1 ── * secret_versions
secrets.current_version_id ──▶ secret_versions.id
```

- `(project_id, name)` unique where `deleted_at IS NULL`.
- `secret_versions` immutable; only `current_version_id` moves.
- `ciphertext`, `nonce`, `wrapped_dek`, `wrap_nonce`, `wrap_tag`, `kek_id` per version.
- AAD binds `objectType=secret`, project id, object id, and version.

### Write path

1. Validate authz (`secret.write`) and input.
2. Encrypt with a fresh DEK and the current KEK.
3. In one transaction: insert version, update current version, insert audit event.
4. Return metadata and capabilities; never the value.

### Read path

1. Validate authz (`secret.read`) and version.
2. Write audit event first; fail closed if it fails.
3. Decrypt, return value, zero buffers after serialization.
4. Expired version returns 410.

### Limits

| Item | Limit |
|---|---|
| Value | 64 KiB |
| Name | 1–127 chars, allowlist |
| Tags | 15 pairs, key 1–64, value 1–256 |
| Versions per secret | 1,000 active (then require purge/cleanup) |
| Idempotency window | 24 hours |

### Envelope validation

- Reject malformed envelopes before key lookup with `CryptoInputError`.
- Require strict, canonical base64 for every binary field.
- Reject unknown fields, wrong lengths, and over-limit ciphertext.
- Validate `projectId`, `objectId`, and `version` as non-empty strings with the same
  allowlists used by the API.
- AAD includes `objectType=secret`, so a certificate envelope moved into a secret row fails
  authentication.
- Empty plaintext is rejected at the API; the crypto primitive still supports an authenticated
  empty ciphertext.

## Integration Points

- RD-06 enforces actions and capabilities.
- RD-07 records read/write/delete/recover/purge events.
- RD-09 mirrors the lifecycle for certificates.
- RD-10 fetches values for agents and reads consumer metadata.
- RD-11 and RD-12 consume the API.
- RD-13 backs up and restores secrets.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Value limit | 25 / 64 / 256 KiB | 64 KiB | Fits common secrets and cert material | AR-26 |
| Empty values | Allow / reject | Reject at API | Avoid meaningless secrets | AR-8 |
| Encoding | UTF-8 only / base64 | UTF-8 + base64 | Support binary safely | AR-9 |
| Soft delete | Immediate / 30 days / 90 days | 30 days | Recovery window | AR-10 |
| Purge protection | Default on / opt-in | Opt-in, one-way | Avoid accidental permanent loss | AR-6 |
| Concurrency | Last write / version check | Immutable versions + idempotency | Safe retries | AR-28 |

## Security Considerations

- **Data sensitivity:** secret values are the highest-value asset.
- **Input validation:** name allowlist, size limits, encoding, tags, idempotency key.
- **Authentication & authorization:** `secret.*` actions with scopes; no value without
  `secret.read`.
- **Injection risks:** parameterized SQL; no shell; no template rendering of values.
- **Encryption needs:** AES-256-GCM envelope; KEK outside DB; TLS.
- **Rate limiting:** data-plane 600/min per principal.
- **Infrastructure:** ciphertext at rest; no values in logs; tmpfs only on the agent side.

## Acceptance Criteria

1. [ ] Creating a secret with a 64 KiB value succeeds; 64 KiB + 1 byte returns 413.
2. [ ] Creating an empty or whitespace-only secret returns 422.
3. [ ] Every write creates a new version; previous versions remain readable by id.
4. [ ] A list response contains no `value` field for any item.
5. [ ] A name containing `/`, `..`, a control character, or a Unicode look-alike returns 422.
6. [ ] A replay with the same `Idempotency-Key` returns the same version and does not create
   a second row.
7. [ ] A soft-deleted secret is hidden from reads/lists, recoverable within 30 days, and
   purged only after retention with protection disabled.
8. [ ] Enabling purge protection then attempting purge returns 409, and protection cannot be
   disabled.
9. [ ] A forced audit failure rolls back the version insert.
10. [ ] A project-scoped reader cannot read a secret in another project or list its metadata.
11. [ ] Capability flags match the policy evaluator for every role.
12. [ ] Secret metadata includes consumer names and no host paths.
13. [ ] Security requirements verified: encryption, authz, limits, no value leakage.
