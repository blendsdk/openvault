# Ambiguity Register: RD-07 Audit Implementation Plan

> **Status**: ✅ GATE PASSED — all 30 items resolved
> **Last Updated**: 2026-11-04 13:20
> **CodeOps Artifact Schema**: 1

## Scope Baseline

| Boundary | Content |
|---|---|
| **Planning target** | `openvault-v0-1/RD-07` — the append-only, hash-chained audit log, its API, retention, and every current emitter |
| **Context artifacts** | RD-07 requirements; RD-06 requirements and plan; RD-02/RD-03/RD-05 code and tests; `audit_events`/`audit_keys`/`audit_checkpoints` schema and triggers; keyring and envelope crypto; controllers, auth, agent, identity, policy, and integration-test harness |
| **Modification set** | New plan documents under `codeops/features/openvault-v0-1/plans/rd-07-audit/`; implementation, tests, docs, and changeset as described by this plan. No requirement document is modified. |

## Register

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|---|---|---|---|---|
| 1 | Behavioral | Whether an assignment mutation is one combined event or a decision event plus a mutation event | Decision + mutation / one combined / success-only | User: "Decision + mutation (Recommended)" — one authorization decision event per attempt, plus one `assignment.grant`/`assignment.revoke` event on success; acceptance counts one decision event per attempt | ✅ Resolved |
| 2 | Non-functional | Audit endpoint rate limits, unspecified by the RD | 60/10/5 / 30/5/2 / shared 60 | User: "60 / 10 / 5 (Recommended)" — events 60/min, verify 10/min, export 5/min per principal | ✅ Resolved |
| 3 | Scope | Which login paths emit authentication events | Local + CLI + OIDC / local + CLI / failures only | User: "Local + CLI + OIDC (Recommended)" — success and failure for all three, plus lockout | ✅ Resolved |
| 4 | Security | How the prune command obtains delete authority | Dedicated prune URL / relax trigger / defer | User: "Dedicated prune URL (Recommended)" — `OPENVAULT_PRUNE_DB_URL` with session user `openvault_pruner`, used only for the delete transaction | ✅ Resolved |
| 5 | Naming & terminology | Action strings and owner for every audit event family | One catalog / per-family strings / reuse policy actions only | Authority: AI — delegated by --auto-design. One frozen catalog; policy decisions keep RD-06 action strings; business events add `auth.*`, `agent.*`, `consumer.*`, `audit.*`, `backup.*` | ✅ Resolved |
| 6 | Data & state | Exact stored and public event shape beyond the RD minimum | RD minimum / add `projectId` and hashes / hide hashes | Authority: AI — delegated by --auto-design. Add `projectId` and expose `prevHash`, `hash`, `hmac`, `auditKeyId` as lowercase hex | ✅ Resolved |
| 7 | Technical | Canonical JSON rules for unsupported values, key order, and size | RFC 8785 / subset serializer / JSON.stringify | Authority: AI — delegated by --auto-design. Small strict serializer: sorted keys, no whitespace, JSON primitive subset, no lone surrogates, bounded depth and size | ✅ Resolved |
| 8 | Technical | Hash/HMAC byte input and timestamp precision | Hex canonical object + raw prefix / raw-only / DB-defaulted time | Authority: AI — delegated by --auto-design. Canonical object carries `prevHash` and `auditKeyId` as hex; hash prefix is raw `prevHash`; explicit millisecond `ts` | ✅ Resolved |
| 9 | Technical | Audit HMAC key creation, wrapping, caching, and rotation readiness | Create on first write / require pre-provisioned key / key per process | Authority: AI — delegated by --auto-design. Create one key under the chain lock on first write; wrap with the current KEK and a key-bound AAD; unwrap per operation; no persistent key cache | ✅ Resolved |
| 10 | Technical | Chain serialization mechanism and transaction ownership | Advisory lock / table lock / sequence-only | Authority: AI — delegated by --auto-design. Fixed transaction-scoped advisory lock held across insert and commit; decision events use an independent transaction; mutation and agent events join the caller transaction | ✅ Resolved |
| 11 | Behavioral | When checkpoints are written and what the HMAC covers | Every 1,000 + daily scheduler / lazy daily / no checkpoints | Authority: AI — delegated by --auto-design. First event, 1,000 further events after the last checkpoint, and first write after 24 h; also on maintenance operations; HMAC over decimal sequence id plus 32-byte hash; no scheduler. The first-event checkpoint makes the next checkpoint event 1,001. | ✅ Resolved |
| 12 | Behavioral | Verification start point, tail detection, and report contents | Earliest usable checkpoint / latest checkpoint / genesis always | Authority: AI — delegated by --auto-design. Anchor at the checkpoint immediately before the first retained event (or at the first event, or genesis); include the first retained anchor event in the walk and recompute its hash/HMAC; check every checkpoint at or after the retained window; an empty table with a checkpoint is `tail_truncated`; an unreadable checkpoint key fails closed; stable reason codes | ✅ Resolved |
| 13 | Technical | Event query filters, order, page size, and cursor mechanism | Keyset id cursor / offset cursor / timestamp cursor | Authority: AI — delegated by --auto-design. Descending sequence id, keyset cursor signed with the audit key and bound to a normalized filter hash (no `limit`, `cursor`, or undefined keys); `objectId` requires `objectType` so the composite index is used; default 100, maximum 500 | ✅ Resolved |
| 14 | Security | Project visibility and whether project auditors may verify the global chain | Org-only verify / any audit.read verify | User: "Org scope only (Recommended)" — query/export use project visibility; verify requires org-scoped `audit.read` | ✅ Resolved |
| 15 | Technical | Export format, streaming, and failure behavior | NDJSON stream / JSON array / CSV | Authority: AI — delegated by --auto-design. NDJSON attachment streamed in batches; the `audit.export` attempt event is written after authorization and before the first byte; pre-stream failure returns 503; a mid-stream failure leaves the attempt event and writes no second event | ✅ Resolved |
| 16 | Security | Which `details` keys are stored and how redaction is enforced | Per-action allowlist / free-form object / drop unknown keys | Authority: AI — delegated by --auto-design. Per-action allowlist validated before canonicalization; unknown keys reject the write; no secret, token, cookie, key, or CSR field | ✅ Resolved |
| 17 | Behavioral | Fail-closed scope and atomicity of event writes | Secret reads only / every audited action / best effort | Authority: AI — delegated by --auto-design. Every audited action fails closed; decision events commit independently; mutation and agent events share the caller transaction | ✅ Resolved |
| 18 | Technical | How the persistent writer replaces RD-06's logging port | Adapter swap / change callers / keep both sinks | Authority: AI — delegated by --auto-design. Replace the adapter behind `PolicyAuditPort`; preserve the denial counter in details; add `projectId` to decision and mutation events; assignment mutations carry `objectType: "assignment"` and `objectId` | ✅ Resolved |
| 19 | Behavioral | Identity attempts currently make two audited policy calls | Keep both / record one composite / disable auditing | Authority: AI — delegated by --auto-design. One audited decision per attempt; visibility checks become non-auditing; request context is plumbed through identity methods | ✅ Resolved |
| 20 | Behavioral | Authentication event reasons and lockout representation | Separate lockout event / one event with a flag / no lockout event | Authority: AI — delegated by --auto-design. `auth.login` for every success/failure plus `auth.lockout` when a failure creates a lock; method and reason only, no identifier or credential; an allow event is written only after the final credential recheck and before delivery, so a credential race yields one deny, not a false allow | ✅ Resolved |
| 21 | Behavioral | Agent join failure actor and reason mapping | System actor for all / token owner for all / RD rule | Authority: AI — delegated by --auto-design. Follow RD-07: system actor for unknown/expired/inactive, token owner for used/revoked; stable reason codes; no token, hash, CSR, or key material; renewal failures use an independent write after rollback; a replay is the same issuance and writes no second event | ✅ Resolved |
| 22 | Behavioral | How consumer register versus update is detected | Compare before upsert / always register / always update | Authority: AI — delegated by --auto-design. Lock and read the existing row, compare metadata excluding `last_seen`; no row means register, changed metadata means one update, `last_seen` alone means no event | ✅ Resolved |
| 23 | Behavioral | Prune order, cutoff, output, and completion event | Export→checkpoint→delete / delete→export / dry-run only | Authority: AI — delegated by --auto-design. Require an output path; verify the retained chain before any export or delete; cut off at retention; write checkpoint at the last deleted event before deleting; record `audit.prune` after success; support dry-run; the pruner role has `SELECT, DELETE`; an empty table after a failed prune event links the next event to the boundary checkpoint | ✅ Resolved |
| 24 | Data & state | Whether new tables or columns are required | New migration / reuse existing schema | Authority: AI — delegated by --auto-design. Reuse the existing tables, indexes, checks, and append-only triggers; no migration and no generated-type change; `objectId` requires `objectType` so the existing composite `(object_type, object_id)` index is used and no standalone index is added | ✅ Resolved |
| 25 | UX & presentation | HTTP mapping for audit failures and tamper results | 503/422/403 + 200 `ok:false` / 500 for tamper / always 200 | Authority: AI — delegated by --auto-design. Audit unavailable is 503, invalid filter/cursor is 422, policy denial is 403, tamper is 200 with `ok:false` and a reason; the 503 mapping is wired into the existing auth, CLI, OIDC, identity, assignment, agent, and audit controllers | ✅ Resolved |
| 26 | Technical | How audit tests obtain a clean chain and prune role | Reuse `seedBase` / fresh database / fake writer | Authority: AI — delegated by --auto-design. Chain tests use a fresh database without the synthetic audit fixture; the test harness provisions the pruner role with `SELECT, DELETE` on `audit_events`; unit tests use deterministic clocks and real crypto | ✅ Resolved |
| 27 | UX & presentation | Documentation and release-note surface | API + guide only / full docs set / none | Authority: AI — delegated by --auto-design. Update API reference, audit guide, configuration, CLI reference, security limitations, changelog, and add a changeset | ✅ Resolved |
| 28 | Stakeholder conflicts | Whether a standing specialist is warranted | None / audit reviewer / crypto reviewer | Authority: AI — delegated by --auto-design. None; the existing security, crypto, and concurrency lenses cover the domain and no repeated rework evidence exists | ✅ Resolved |
| 29 | Data & state (runtime) | A decision can name a project that does not exist, while `audit_events.project_id` has a foreign key to `projects` | Reject before authorization / persist at system scope / relax the foreign key | Authority: AI — delegated by --auto-design. Persist the decision at system scope with `projectId` null and keep the requested object type and id, so the attempt still reaches the log and the schema stays unchanged | ✅ Resolved |
| 30 | Technical (runtime) | Assignment decisions are recorded while the assignment transaction is active, but one database handle cannot open a nested transaction | Independent audit pool / defer the write / join the caller transaction | Authority: AI — delegated by --auto-design. Decision events use a dedicated audit pool with a short idle timeout, so they commit independently of the assignment transaction; mutation events still join the caller transaction. Every attempt produces exactly one decision event, including a failed insert after authorization | ✅ Resolved |

## Resolution Notes

### User Decisions

**AR-1:** The RD-06 port records two distinct facts: the authorization decision and the successful state change. RD-07 keeps both. A denied attempt produces exactly one decision event. A successful assignment change produces one decision event plus one `assignment.grant` or `assignment.revoke` event. The same separation applies to audit operations: the `audit.read` decision is one event and the `audit.verify`/`audit.export` result is a separate event.

**AR-2:** Per-principal limits: `GET /v1/audit/events` 60/min, `GET /v1/audit/verify` 10/min, `GET /v1/audit/export` 5/min. The limiter key is the authenticated principal id, never a forwarded address. Test overrides are allowed through the same service pattern as the RBAC limiters.

**AR-3:** Browser local login, CLI local login, and OIDC callback all emit `auth.login` on success and failure. A failed attempt that creates the 15-minute credential lock also emits `auth.lockout`. Details carry the method and a stable reason, never the identifier, password, token, cookie, or provider subject.

**AR-4:** The prune command reads `OPENVAULT_PRUNE_DB_URL`. Its session user must be `openvault_pruner`; the trigger already enforces that name. The URL is maintenance-only and is not part of the server's validated runtime configuration. The delete transaction sets `openvault.allow_audit_prune = 'on'`, exports first, and writes the checkpoint through the application connection before deleting.

**AR-5:** Frozen action catalog:

| Family | Action strings | This plan emits |
|---|---|---|
| Authentication | `auth.login`, `auth.lockout` | yes |
| Authorization | RD-06 action strings, including `audit.read` | yes |
| Assignment changes | `assignment.grant`, `assignment.revoke` | yes |
| Identity | `identity.create`, `identity.revoke`, `identity.join_token` | via policy decisions |
| Agent | `agent.join`, `agent.renew` | yes |
| Consumer | `consumer.register`, `consumer.update` | yes |
| Audit operations | `audit.verify`, `audit.export`, `audit.prune` | yes |
| Future data plane | `project.*`, `secret.*`, `certificate.*`, `kek.rotate` | policy decisions only; RD-08/RD-09/RD-13 add business details |
| Future operations | `backup.create` | no; reserved for RD-13 |

The catalog is the query-filter allowlist and the details-allowlist key. Secret and certificate reads are policy decisions; RD-08/RD-09 must authorize before returning data, so no second business event is added for the same attempt.

**AR-6:** Stored and public fields are the RD minimum plus `projectId`. `projectId` is `scopeId` for project scope and null for org/system scope. The query response exposes `prevHash`, `hash`, `hmac`, and `auditKeyId` as lowercase hex so an auditor can independently inspect the chain. The database `id` sequence is not exposed; `eventId` is the ULID.

**AR-7:** Canonical JSON accepts only `null`, booleans, finite numbers, strings, arrays, and plain objects. It rejects `undefined`, bigint, functions, symbols, non-finite numbers, class instances, dates, cycles, lone surrogates, depth above 8, and serialized details above 16 KiB. Object keys sort with the default JavaScript string order. Strings use JSON escaping and UTF-8 output. No whitespace.

**AR-8:** The canonical object contains every stored field except `hash` and `hmac`, including `prevHash` and `auditKeyId` as lowercase hex. `ts` is an explicit ISO-8601 string with millisecond precision. The hash is `SHA-256(prevHashBytes || canonicalUtf8)`. The HMAC is `HMAC-SHA256(auditKey, hashBytes)`. The DB receives the same explicit timestamp so a read-back reconstructs identical bytes.

**AR-9:** On first write, inside the chain transaction, the writer selects the oldest `audit_keys` row; if none exists it generates 32 random bytes and inserts a row wrapped with the current KEK. Wrap AAD is `ov:audit-key:v1:<keyId>:<kekId>`; the row stores the 32-byte ciphertext, 12-byte nonce, 16-byte tag, and KEK id. Each write and each verification run unwraps the named key on demand; there is no long-lived key cache. Key buffers are zeroed after use. Missing or unreadable keys make writes fail closed and make verification report `key_unavailable`.

**AR-10:** All chain inserts take `pg_advisory_xact_lock` on the fixed value `780217001`, reserved for this chain. The lock is acquired before reading the previous hash and held to commit. Policy decision events run in an independent transaction so a denial survives a rolled-back mutation transaction. Mutation events join the caller's transaction after the mutation succeeds, so evidence and state change commit or roll back together. Agent join/renew and consumer events share their operation transaction.

**AR-11:** A checkpoint is created with the first event, after 1,000 further events since the last checkpoint (event 1,001 after the first-event checkpoint), and on the first write at least 24 hours after the last checkpoint. Verify, export, and prune also request a due checkpoint. Checkpoint and triggering event share one transaction. The checkpoint HMAC is `HMAC-SHA256(auditKey, utf8(lastEventSequenceId) || lastHash)`. There is no scheduler; a quiet chain needs no new anchor because its tail has not moved.

**AR-12:** Verification anchors at the checkpoint immediately before the first retained event. If no such checkpoint exists, it anchors at a checkpoint on the first event, or at genesis when the first event's `prevHash` is 32 zero bytes. When the anchor is the first retained event, that event is included in the walk and its canonical hash/HMAC are recomputed; the verifier never trusts only the stored row hash. It never skips forward past retained events, because that could hide tampering in the skipped prefix. A checkpoint with a bad HMAC is a failure, not a reason to skip. Events are checked in ascending sequence id. Every checkpoint at or after the first retained event is checked; any checkpoint that references a missing event reports `tail_truncated`, so a newer checkpoint cannot mask an older deletion. An empty event table with a surviving checkpoint is `tail_truncated`; an unreadable checkpoint key fails closed. Reasons: `ok`, `empty_chain`, `missing_checkpoint`, `checkpoint_mismatch`, `prev_hash_mismatch`, `hash_mismatch`, `hmac_mismatch`, `key_unavailable`, `tail_truncated`. `checkedRange` reports the first and last retained event ULIDs actually checked, nullable when empty.

**AR-13:** `GET /v1/audit/events` orders by sequence id descending. Filters are `from`, `to`, `actorId`, `action`, `objectType`, `objectId`, `result`, `requestId`, and `projectId`. The cursor is `base64url(payload).base64url(hmac)` where the payload is `{v:1, kid, id, f}`, `f` is the SHA-256 of the canonical filter object excluding `cursor` and `limit`, and the HMAC uses the named audit key with the `ov:audit-cursor:v1:` domain prefix. A cursor used with different filters is 422. Default page size 100, maximum 500.

**AR-14:** Query and export compute visibility through the policy engine's `audit.read` list decision. An org grant sees every event, including org and system events. Project grants see only rows whose `project_id` is in the granted set; a requested `projectId` outside that set is 403. `GET /v1/audit/verify` requires an org-scoped `audit.read` grant because it checks the global chain; a project-scoped auditor receives 403. Each request records one decision event.

**AR-15:** Export returns `application/x-ndjson` with an attachment filename. It writes the `audit.export` event with the normalized filters before the first byte; an audit failure returns 503 before headers. Rows stream in batches of 500 in ascending id order. A mid-stream database failure destroys the response; the partial file is the client's responsibility to discard. Export never includes checkpoints.

**AR-16:** Each action has an allowlist of permitted keys. Values are scalars, except `changed` (a string array) and `filters` (the only nested object). The writer validates keys and value types before canonicalization and rejects unknown keys. Allowed details include identifiers, roles, reason codes, policy versions, changed field names, consumer metadata, certificate serials, and counts. Forbidden everywhere: secret values, private keys, passwords, tokens, token hashes, cookies, CSR bodies, and request bodies. Truncation is not used to hide invalid input; the write fails.

**AR-17:** Every audited operation fails closed: if the event cannot be persisted, the operation returns 503 or its transaction rolls back. Policy decision events are committed independently before the mutation proceeds. Mutation events are part of the mutation transaction. Agent join/renew and consumer events are part of the join/renew transaction, so an audit failure rolls back the certificate, token claim, and consumer change. One accepted non-atomic case remains: a wrong-password attempt increments the credential failure counter before its deny event is written; if the audit write then fails, the counter stays advanced but no session or token is issued and the client receives 503. The counter is not a user-visible resource, and moving it would add a second transaction seam.

**AR-18:** `PersistentPolicyAudit` implements `PolicyAuditPort`. It maps decision events to `scopeType` (`org`, `project`, `system`), derives `projectId`, stores `reason`, `policyVersion`, and the bounded per-principal `denialCount` in details, and records mutation events with `assignmentId`, `targetPrincipalId`, `role`, and `policyVersion`. `PolicyMutationEvent` gains `projectId` so object-scoped assignments satisfy the database check. The logging adapter remains for unit tests that do not use the database.

**AR-19:** Identity service methods accept an optional `PolicyAuditContext` and pass it to the authorizer. `IdentityAuthorizer.can` and `hasAny` accept context; `hasAny` gains an `{ audit?: boolean }` option. Revoke, join-token, and get use one audited decision on the identity resource; the visibility check that chooses 403 versus 404 is non-auditing. Create keeps one audited decision on the project resource because the identity does not exist yet. List keeps one list decision.

**AR-20:** `auth.login` is `allow` on success and `deny` on failure. Reasons: `unknown_credentials`, `inactive_principal`, `locked`, `invalid_credentials`, `invalid_hash`, `oidc_flow`, `oidc_unavailable`, `access_denied`, `link_collision`. `client` is `browser` or `cli`; `method` is `local` or `oidc`. `auth.lockout` is `deny` with `lockSeconds: 900` and is written only when the failure creates the lock. Success events are written before session or token issuance, so a write failure prevents issuance. Failure events are written before the controller returns the generic 401; a write failure returns 503.

**AR-21:** Join failures record exactly one `agent.join` event. Unknown and expired tokens, inactive principals, and inactive projects use a system actor. Used and revoked tokens, and a lost claim race, use the token's service principal. Invalid CSR uses a system actor. CA and certificate-conflict failures use the known service actor with `error`. Reasons: `invalid_csr`, `join_token_unknown`, `join_token_expired`, `join_token_used`, `join_token_revoked`, `principal_inactive`, `project_inactive`, `join_token_claim_failed`, `ca_unavailable`, `certificate_conflict`, `internal_error`. Renew failures always use the authenticated service actor with `invalid_csr`, `renewal_not_current`, `renewal_not_due`, `principal_inactive`, `project_inactive`, `ca_unavailable`, `certificate_conflict`, or `internal_error`. No event field carries the token, token hash, CSR, private key, or certificate body.

**AR-22:** Join and renew lock the consumer row, compare compose project, compose service, hostname, manifest hash, and state, then upsert. A missing row emits `consumer.register`; a metadata change emits one `consumer.update` with the changed field names and current metadata; a `last_seen`-only change emits nothing. The event is in the same transaction as the upsert.

**AR-23:** `OPENVAULT_PRUNE_DB_URL` is required by the command. The command loads the normal config for retention and keyring, exports matching events to the required `--out` file, writes a checkpoint at the highest deleted sequence id through the application connection, then deletes `id <= cutoff` through the prune connection with `SET LOCAL openvault.allow_audit_prune = 'on'`. `--dry-run` performs export and checkpoint planning but no delete. On success it records `audit.prune` through the application connection with cutoff, counts, checkpoint id, and dry-run flag. If every event is pruned, the prune event links to the boundary checkpoint's hash so the retained chain still starts from the anchor. Missing URL, wrong session user, or checkpoint failure aborts before deletion.

**AR-24:** The existing schema already has every table, column, check, index, foreign key, and trigger needed. No migration is created; `db:types` and `db:types:check` must remain unchanged. The `audit_events` primary key supplies the keyset order, and the existing indexes cover the filters.

**AR-25:** `AuditUnavailableError` maps to 503 `service_unavailable`. Invalid filters, limits, or cursors map to 422 `validation_error`. A denied `audit.read` maps to 403 `access_denied`. A requested project outside visibility maps to 403. A broken chain is a successful HTTP response with `ok:false` and a reason. Unknown routes remain WebAFX defaults.

**AR-26:** New chain tests create a disposable database and seed only business fixtures; they do not call the synthetic audit rows in `seedBase`. `seedBase` stops inserting the invalid audit key/event/checkpoint by default; the schema test that needs those rows calls a dedicated `seedAuditFixture` helper. The integration harness provisions `openvault_pruner` once per test cluster when the connected user is allowed to create roles, and grants `DELETE` on `audit_events`; the prune integration test connects with that role. Unit tests use a deterministic clock and real Node crypto.

**AR-27:** Update `docs/reference/api.md` with the three routes, filters, response examples, and status codes; expand `docs/guide/audit.md` with verification, export, retention, and the prune command; document `OPENVAULT_PRUNE_DB_URL`, the `openvault_pruner` role, and the checkpoint export command in `docs/reference/configuration.md` and `docs/reference/cli.md`; update `docs/changelog.md`; add a minor changeset for `@openvault/api-contract` and `@openvault/server`. The checkpoint export is a maintenance integrity read and does not create an audit event; the NDJSON event export is the audited export required by the acceptance criteria.

**AR-28:** **None.** Detection evidence: the domain is ordinary TypeScript over existing PostgreSQL, Node crypto, WebAFX, and Vitest patterns. The audit key hierarchy is already documented in `docs/architecture/crypto.md:5-73`; the append-only triggers already exist in `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27`; the policy port already exists at `apps/server/src/rbac/audit.ts:81-86`. Existing security, crypto, and concurrency review lenses cover the risks. No repeated rework evidence exists and no catalog role would be replaced by a standing specialist.

**AR-29:** A policy decision can reference a project id that has no row in `projects`, for example an identity-create request that names an unknown project. `audit_events.project_id` is a foreign key, so a project-scoped event for that id cannot be persisted and the request would fail with 503 instead of its expected 422. The persistent adapter checks the project before writing a decision. When the row is absent it records the decision at system scope with a null `projectId` and keeps the requested `objectType`/`objectId`, so the attempt and denial remain visible and no schema change is needed. The check is skipped when no database handle is supplied to the adapter. This is a runtime finding resolved under `--auto-design`.

**AR-30:** `PolicyService.recordDecision` accepts an optional transaction. An assignment transaction cannot open a nested decision transaction on the same database handle, so the writer has a dedicated audit pool (`recordIndependent`) with `max: 1` and a short idle timeout. When a decision is recorded while a caller transaction is active, it commits on that pool; the mutation event still joins the caller transaction. A failed insert after an allowed decision therefore leaves the decision in the log, and a denied decision survives the rollback. The main application and the agent runtime share the same persistent adapter built from the main database and this audit pool. This is a runtime finding resolved under `--auto-design`.

### Auto-Design Provenance

All delegated rows below use `Policy version: 1` and `Root invocation ID: rd-07-audit-make-plan-20261104-001`.

**AR-5**
- Authority: AI — delegated by --auto-design
- Eligibility: Naming and internal interface within the confirmed RD action list; no new product behavior.
- Objective: One stable, queryable action vocabulary for current and future audit writers.
- Decision: Frozen catalog in the register table; policy actions reuse RD-06 strings; business events add the listed names.
- Evidence: `packages/api-contract/src/rbac.ts:15-41`; `apps/server/src/rbac/audit.ts:53`; RD-07 Must Have action strings.
- Rejected alternatives: Free-form action strings (no allowlist); one generic `audit.event` action (loses filtering).
- Strongest counterargument: Adding future `project.*`/`secret.*` strings now may not match RD-08 wording. Mitigation: the catalog is extensible by a later plan; this plan only emits the listed families.
- Confidence: High — RD-08/RD-09 already use the RD-06 action names.
- Hardening: In-context layers only; no independent challenger required for a naming catalog.
- Reopen triggers: An owning RD publishes a conflicting action string.

**AR-6**
- Authority: AI — delegated by --auto-design
- Eligibility: Persistence and API contract mechanism inside the RD's stored-field minimum.
- Objective: Tamper-evident, auditable records that a client can inspect.
- Decision: Add `projectId`; expose hash fields as hex; keep the sequence id private.
- Evidence: `apps/server/src/database/schema.ts:410-446`; RD-07 Technical Requirements event shape.
- Rejected alternatives: Hide hashes (auditors cannot inspect); expose sequence id (leaks volume).
- Strongest counterargument: Public hashes may invite attacks on SHA-256 preimages. Mitigation: the chain already relies on SHA-256 and HMAC; visibility is limited by `audit.read`.
- Confidence: High.
- Hardening: In-context layers only.
- Reopen triggers: A client contract requires a different field name.

**AR-7**
- Authority: AI — delegated by --auto-design
- Eligibility: Algorithm and serialization choice inside the RD canonical JSON rules.
- Objective: Byte-stable hashing across writer and verifier.
- Decision: Strict subset serializer with sorted keys, no whitespace, bounded depth and size.
- Evidence: RD-07 Technical Requirements §Canonical JSON; Node `JSON.stringify` behavior.
- Rejected alternatives: RFC 8785 full implementation (extra dependency and number-format surface); raw `JSON.stringify` (insertion-order dependent).
- Strongest counterargument: A hand-written serializer can diverge on Unicode escaping. Mitigation: use `JSON.stringify` for each string value and test lone surrogates explicitly.
- Confidence: High.
- Hardening: In-context layers plus deterministic test vectors.
- Reopen triggers: A cross-language verifier needs RFC 8785.

**AR-8**
- Authority: AI — delegated by --auto-design
- Eligibility: Hash input and persistence encoding.
- Objective: Recompute the same hash from a database row.
- Decision: Hex fields in canonical JSON; raw prev hash prefix; explicit millisecond timestamps; `sourceIp` normalized through PostgreSQL `inet` before hashing.
- Evidence: RD-07 hash formula; `pg` returns `timestamptz` as a millisecond `Date` and canonicalizes `inet` text.
- Rejected alternatives: Hash the raw row bytes (driver-dependent); store text timestamps (precision drift).
- Strongest counterargument: Millisecond precision loses sub-millisecond ordering. Mitigation: sequence id provides order; timestamps are evidence, not the chain order.
- Confidence: High.
- Hardening: In-context layers plus round-trip tests.
- Reopen triggers: PostgreSQL driver precision changes.

**AR-9**
- Authority: AI — delegated by --auto-design
- Eligibility: Key-management mechanism within the approved KEK hierarchy.
- Objective: HMAC keys usable by the writer and verifier without storing plaintext.
- Decision: One KEK-wrapped key created under the chain lock; per-operation unwrap; no cache.
- Evidence: `apps/server/src/database/schema.ts:401-408`; `packages/core/src/crypto.ts:1-7`; `apps/server/src/security/keyring.ts:114-132`.
- Rejected alternatives: Pre-provision key file (new operational surface); plaintext key column (violates schema).
- Strongest counterargument: Per-write unwrap adds AES latency. Mitigation: one AES-GCM unwrap per event is negligible beside the database insert.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: KEK rotation cadence makes per-write unwrap material.

**AR-10**
- Authority: AI — delegated by --auto-design
- Eligibility: Concurrency and transaction design.
- Objective: One global chain order and evidence that survives rollbacks.
- Decision: Fixed transaction advisory lock; independent decision transactions; caller transaction for mutations and agent events.
- Evidence: `apps/server/src/security/signing-keys.ts:347` uses the same lock pattern; `apps/server/src/rbac/assignment-service.ts:163-225`.
- Rejected alternatives: Table lock (blocks reads); sequence-only (no prev-hash serialization).
- Strongest counterargument: Holding the chain lock for a long mutation transaction limits audit throughput. Mitigation: mutations are admin-rate operations; correctness wins.
- Confidence: High.
- Hardening: Independent concurrency review planned in the execution phase.
- Reopen triggers: Deadlock evidence between `policy_state` and the chain lock, or a caller that requires snapshot isolation for an audited mutation.

**AR-11**
- Authority: AI — delegated by --auto-design
- Eligibility: Checkpoint scheduling mechanism.
- Objective: Detect tail deletion without adding a scheduler.
- Decision: First event, 1,000 further events, lazy daily, plus maintenance triggers.
- Evidence: RD-07 checkpoint requirements; no scheduler exists in `apps/server/src`.
- Rejected alternatives: In-process timer (new lifecycle surface); external cron (new deployment dependency).
- Strongest counterargument: A quiet chain gets no new daily checkpoint. Mitigation: an unchanged tail is already anchored by the last checkpoint; no new evidence exists.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: RD-13 adds a scheduler for retention.

**AR-12**
- Authority: AI — delegated by --auto-design
- Eligibility: Verification algorithm and reason vocabulary.
- Objective: Detect edit, middle delete, and tail delete with stable reporting.
- Decision: Anchor at the checkpoint immediately before the first retained event, at the first event's checkpoint, or at genesis; never skip forward past retained events; latest usable checkpoint for the tail check; `key_unavailable` for an unreadable key; reason codes.
- Evidence: RD-07 acceptance 2–4 and technical checkpoint rules; pruning keeps the boundary checkpoint.
- Rejected alternatives: Latest checkpoint start (misses earlier tampering); genesis always (impossible after prune).
- Strongest counterargument: An unavailable boundary key makes the retained window unverifiable. Mitigation: report `key_unavailable` instead of skipping forward; a bad HMAC fails.
- Confidence: High.
- Hardening: In-context layers plus tamper tests.
- Reopen triggers: A retained boundary checkpoint's KEK is removed without re-wrap.

**AR-13**
- Authority: AI — delegated by --auto-design
- Eligibility: Query and pagination mechanism.
- Objective: Stable, tamper-resistant pagination.
- Decision: Descending sequence id, signed filter-bound cursor with a domain-separated HMAC, 100/500 limits.
- Evidence: `apps/server/src/database/schema.ts:440-446`; RD-07 filter list.
- Rejected alternatives: Offset pagination (unstable under inserts); unsigned cursor (filter confusion).
- Strongest counterargument: Signing with the audit key couples queries to key availability. Mitigation: the key is already required to read the chain; unavailable key means 503.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A client needs ascending order.

**AR-14**
- Authority: AI — delegated by --auto-design (user-confirmed reserved scope for verify)
- Eligibility: Authorization mechanism within the RD's project-scoping rule.
- Objective: No cross-project leakage.
- Decision: Policy list visibility for query/export; org scope for verify; one decision event per request.
- Evidence: `apps/server/src/rbac/policy-service.ts:253-329`; `docs/reference/roles.md:44-56`.
- Rejected alternatives: Ignore project filter (silent scope widening); allow project verify (global leak).
- Strongest counterargument: Project auditors cannot verify their own chain. Mitigation: verification is a global integrity operation; an org auditor owns it.
- Confidence: High.
- Hardening: User confirmed the verify scope.
- Reopen triggers: RD-14 requires project-scoped verification.

**AR-15**
- Authority: AI — delegated by --auto-design
- Eligibility: HTTP streaming mechanism.
- Objective: Export large ranges without buffering.
- Decision: NDJSON attachment, batched ascending rows, audit before stream.
- Evidence: RD-07 export requirement; `docs/guide/audit.md:38-44`.
- Rejected alternatives: JSON array (memory); CSV (lossy details).
- Strongest counterargument: A mid-stream failure leaves a partial file. Mitigation: document; write the export event first so the attempt is recorded.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A client requires resumable export.

**AR-16**
- Authority: AI — delegated by --auto-design
- Eligibility: Redaction mechanism within the RD no-secrets rule.
- Objective: Prevent value leakage into the immutable log.
- Decision: Per-action primitive allowlist; reject unknown keys before hashing.
- Evidence: RD-07 §Security Considerations; `apps/server/src/config/redact.ts` allowlist pattern.
- Rejected alternatives: Regex redaction (misses new shapes); drop unknown keys (silent loss).
- Strongest counterargument: Strict rejection can turn a harmless caller detail into a 503. Mitigation: callers build details from typed fields; tests cover each action.
- Confidence: High.
- Hardening: Independent security review planned.
- Reopen triggers: A new action needs a new detail key.

**AR-17**
- Authority: AI — delegated by --auto-design
- Eligibility: Failure and transaction design within RD-07 fail-closed policy.
- Objective: No action without evidence.
- Decision: All audited actions fail closed; transaction boundaries as in AR-10.
- Evidence: RD-07 feature overview and acceptance 5; requirements AR-27.
- Rejected alternatives: Best effort for non-secret actions (inconsistent evidence); audit-after-response (lost denials).
- Strongest counterargument: Audit unavailability can take down login and join. Mitigation: that is the accepted fail-closed trade-off; readiness reports audit health.
- Confidence: High.
- Hardening: Independent security review planned.
- Reopen triggers: Availability requirements override fail-closed for a specific action.

**AR-18**
- Authority: AI — delegated by --auto-design
- Eligibility: Internal interface replacement.
- Objective: Persistent evidence without changing policy callers.
- Decision: `PersistentPolicyAudit` behind the existing port; add `projectId` to mutation events.
- Evidence: `apps/server/src/rbac/audit.ts:81-86`; `apps/server/src/rbac/runtime.ts:39-55`.
- Rejected alternatives: Change every caller (larger diff); dual-write logger and database (duplicate evidence).
- Strongest counterargument: The port shape may not fit future business events. Mitigation: business events use the audit service directly; the port stays policy-specific.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A second policy consumer needs a different port.

**AR-19**
- Authority: AI — delegated by --auto-design
- Eligibility: Internal call-flow correction required by acceptance 1.
- Objective: Exactly one decision event per identity attempt.
- Decision: One audited decision; non-auditing visibility checks; context plumbing.
- Evidence: `apps/server/src/identity/identity-service.ts:203-263`; `apps/server/src/identity/identity-authorizer.ts:55-71`; `apps/server/src/rbac/policy-service.ts:401-471`.
- Rejected alternatives: Keep two events (violates acceptance 1); disable audit on both (loses evidence).
- Strongest counterargument: The visibility check still evaluates policy twice. Mitigation: the second evaluation is explicitly non-auditing and does not create evidence.
- Confidence: High.
- Hardening: In-context layers plus event-count tests.
- Reopen triggers: A policy API change removes non-auditing evaluation.

**AR-20**
- Authority: AI — delegated by --auto-design
- Eligibility: Internal event semantics within the confirmed auth coverage.
- Objective: Correlate login outcomes without storing credentials.
- Decision: `auth.login` plus `auth.lockout`; stable reasons; method/client only.
- Evidence: `apps/server/src/auth/local-login.ts:98-144`; `apps/server/src/auth/credentials.ts:172-201`; controllers.
- Rejected alternatives: One event with a `locked` flag (less filterable); identifier hash in details (unnecessary linkage).
- Strongest counterargument: A lockout produces two events. Mitigation: they are distinct facts and are separately filterable.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: RD-14 needs a different abuse signal.

**AR-21**
- Authority: AI — delegated by --auto-design
- Eligibility: Failure mapping required by the RD actor rule.
- Objective: One non-leaking event per join/renew attempt.
- Decision: Actor/reason table in AR-21; no token, hash, CSR, or key material.
- Evidence: `apps/server/src/agent/agent-join-service.ts:75-180`; `apps/server/src/agent/agent-renew-service.ts:195-328`; RD-07 acceptance 11.
- Rejected alternatives: Always system actor (loses used/revoked attribution); include token id (linkable).
- Strongest counterargument: A system actor for an inactive principal hides the known principal. Mitigation: the RD explicitly requires system for that case.
- Confidence: High.
- Hardening: Independent security review planned.
- Reopen triggers: A new join failure mode needs a reason code.

**AR-22**
- Authority: AI — delegated by --auto-design
- Eligibility: Change detection mechanism.
- Objective: Audit metadata changes without heartbeat noise.
- Decision: Lock, compare excluding `last_seen`, emit register/update/none.
- Evidence: `apps/server/src/agent/consumer-repository.ts:90-123`; RD-07 acceptance 12.
- Rejected alternatives: Always update (noise); database trigger (new migration and hashing coupling).
- Strongest counterargument: The first join always emits a register event even if the metadata matches a previously deleted row. Mitigation: a deleted consumer row is a new registration.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: RD-10 introduces a heartbeat-only path.

**AR-23**
- Authority: AI — delegated by --auto-design (user-confirmed credential model)
- Eligibility: Maintenance command flow.
- Objective: Export, anchor, then delete without losing evidence.
- Decision: Required `--out`, checkpoint at the last deleted event, pruner connection for delete, prune event after; prune-all links to the boundary hash.
- Evidence: `apps/server/migrations/20261030094213_triggers-and-seed.up.sql:9-27`; RD-07 retention rules.
- Rejected alternatives: Delete first (unrecoverable); no checkpoint (unverifiable retained window).
- Strongest counterargument: A checkpoint at a deleted event cannot be re-derived. Mitigation: the checkpoint carries the hash and HMAC and is retained permanently.
- Confidence: High.
- Hardening: User confirmed the credential separation.
- Reopen triggers: RD-13 defines a different retention job.

**AR-24**
- Authority: AI — delegated by --auto-design
- Eligibility: Persistence mechanism.
- Objective: Smallest change that satisfies the chain.
- Decision: Reuse the existing schema; no migration.
- Evidence: `apps/server/src/database/schema.ts:397-455`; `apps/server/migrations/20261030094203_initial.up.sql:6-42`.
- Rejected alternatives: New `audit_state` table (duplicate source of truth); new chain column (breaks the documented shape).
- Strongest counterargument: The `audit_keys` table has no "current" marker. Mitigation: one key is created and always selected first; RD-13 can add rotation metadata when needed.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A requirement needs multiple active keys.

**AR-25**
- Authority: AI — delegated by --auto-design
- Eligibility: HTTP error mapping.
- Objective: Stable client behavior.
- Decision: 503 unavailable, 422 invalid input, 403 denial, 200 `ok:false` for tamper.
- Evidence: `docs/reference/api.md:352-365`; RD-07 verify response.
- Rejected alternatives: 500 for tamper (looks like a server bug); 403 for tamper (confuses authorization).
- Strongest counterargument: A 200 response with `ok:false` can be missed by monitoring. Mitigation: the verify event and docs make the result explicit.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A client requires a non-200 tamper status.

**AR-26**
- Authority: AI — delegated by --auto-design
- Eligibility: Test-harness mechanism.
- Objective: Real chain tests without invalid fixtures.
- Decision: Fresh DB, optional audit fixture, pruner role provisioning, deterministic clock.
- Evidence: `apps/server/tests/integration/helpers/fixtures.ts:149-190` seeds random audit bytes; `apps/server/vitest.integration.config.ts` runs one worker.
- Rejected alternatives: Keep synthetic rows (verification always fails); mock the database (loses SQL and trigger coverage).
- Strongest counterargument: Creating a cluster role in tests needs superuser. Mitigation: CI's `POSTGRES_USER` is superuser; local compose is the same; skip with a clear guard when unavailable.
- Confidence: Medium — role creation depends on the test cluster.
- Hardening: In-context layers; the plan includes a guard and an explicit skip message.
- Reopen triggers: CI moves to a non-superuser test role.

**AR-27**
- Authority: AI — delegated by --auto-design
- Eligibility: Documentation scope.
- Objective: Operators and clients can use the feature.
- Decision: API, guide, configuration, CLI, changelog, changeset.
- Evidence: `docs/reference/api.md:339-345`; `docs/guide/audit.md`; `docs/reference/configuration.md:27`.
- Rejected alternatives: Code-only (operators cannot prune); full architecture rewrite (out of scope).
- Strongest counterargument: The docs already describe the feature, so updates may be small. Mitigation: verify every statement against the implementation and add the missing prune details.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: A route or command name changes.

**AR-28**
- Authority: AI — delegated by --auto-design
- Eligibility: Specialist detection outcome.
- Objective: Avoid unnecessary machinery.
- Decision: None.
- Evidence: `docs/architecture/crypto.md:5-73`; `apps/server/src/rbac/audit.ts:81-86`; existing schema triggers; no recurring finding ledger for audit.
- Rejected alternatives: Audit reviewer (restates base lenses); crypto reviewer (restates documented key hierarchy).
- Strongest counterargument: The hash chain is security-sensitive. Mitigation: the execution plan assigns a security-auditor and design-challenger review to the core and emitter phases.
- Confidence: High.
- Hardening: In-context layers.
- Reopen triggers: Repeated audit-specific review findings across phases.

## Preflight Revisions (2026-11-04)

The preflight audit in [00-preflight-report.md](00-preflight-report.md) revised the following decisions after codebase grounding and an independent challenger review. These revisions supersede the corresponding sentences in the resolution notes above.

| AR | Revision |
|---|---|
| AR-11 | The first checkpoint is at the first event; the next checkpoint is event 1,001 (1,000 further events). ST-15 and ST-39 are updated. |
| AR-12 | The first retained anchor event is included in the walk and its canonical hash/HMAC are recomputed. Every checkpoint at or after the retained window is checked. Empty events with a surviving checkpoint is `tail_truncated`. An unreadable checkpoint key fails closed. Prune verifies the retained chain before deleting. |
| AR-13 | Cursor binding uses `normalizeAuditFilters` (no `limit`, `cursor`, or undefined keys). `objectId` requires `objectType`. |
| AR-15 | `audit.export` is an attempt event written before headers. A mid-stream failure leaves it and writes no second event. |
| AR-18 | `PolicyDecisionEvent` gains `projectId`; assignment mutation events carry `objectType: "assignment"` and `objectId`. |
| AR-20 | Allow events are written after the final credential recheck and before delivery. A credential race writes one deny event. |
| AR-21 | Renewal failure events are independent writes after rollback. A replay writes no second event. |
| AR-23 | Prune verifies first. The pruner role has `SELECT, DELETE`. An empty table after a failed prune event is recoverable through the checkpoint hash. |
| AR-24 | No migration. `objectId` requires `objectType` so the existing composite index is used. |
| AR-25 | `AuditUnavailableError` maps to 503 across the existing controllers. |
| AR-26 | The pruner test role has `SELECT, DELETE`. |
| AR-27 | The security limitations document is updated. |
