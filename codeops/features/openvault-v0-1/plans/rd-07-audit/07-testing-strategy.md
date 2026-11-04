# Testing Strategy: RD-07 Audit

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Canonical serializer and hashing | 95% |
| Writer, key store, checkpoints | 90% |
| Query, cursor, verify, export | 90% |
| Emitters (policy, identity, auth, agent, consumer) | 85% |
| Prune command | 85% |
| Controllers and wiring | 80% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use the real PostgreSQL adapter, real Node crypto, and a real keyring. Only the OIDC provider is faked, using the existing harness.
- Every specification test case below is derived from RD-07, the component documents, or the Ambiguity Register. Expectations are not derived from the implementation.

## Specification Test Cases

### Canonical JSON and Hashing

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | `canonicalJson({ b: 1, a: 2 })` | `{"a":2,"b":1}` | 03-01 §Canonical JSON, AR-7 |
| ST-2 | Nested object `{ z: [{ b: true, a: null }], a: "x" }` | `{"a":"x","z":[{"a":null,"b":true}]}` | 03-01 §Canonical JSON |
| ST-3 | Object with a quote in a string: `{ s: 'a"b' }` | `{"s":"a\"b"}` with no whitespace | 03-01 §Canonical JSON |
| ST-4 | String containing a lone surrogate `"\uD800"` | Throws `CanonicalJsonError`; no output | 03-01 §Canonical JSON, AR-7 |
| ST-5 | Value `undefined`, a function, or a bigint | Throws `CanonicalJsonError` | 03-01 §Canonical JSON |
| ST-6 | `NaN`, `Infinity`, or `-Infinity` | Throws `CanonicalJsonError` | 03-01 §Canonical JSON |
| ST-7 | Object nested nine levels deep | Throws `CanonicalJsonError` at depth 9 | 03-01 §Canonical JSON |
| ST-8 | Full event canonical object with a 32-byte previous hash and key id; fixed primitive vector: canonical `{"a":1}`, 32 zero previous-hash bytes, 32-byte key of `0x01` | Hash equals `SHA-256(prevHashBytes || canonicalUtf8)`; HMAC equals `HMAC-SHA256(key, hash)`. Fixed vector: hash `b06a229070741292512e8760f470dd7a4c46ccfdf253df781d88dabe58c1ccb1`, HMAC `8c7b84a570485cb48ee49ba770b376011aa92022a3e866b8a62bc0fc494093e0` | 03-01 §Hash and HMAC, AR-8 |

### Chain, Keys, and Checkpoints

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-9 | Record the first event in an empty database | `prev_hash` is 32 zero bytes; `hash` and `hmac` are 32 bytes; one `audit_keys` row exists; one checkpoint exists at the event id | 03-01 §Writer, AR-9, AR-11 |
| ST-10 | Record two events sequentially | Second `prev_hash` equals the first `hash`; verification returns `ok` | 03-01 §Writer, AR-10 |
| ST-11 | Start two records concurrently with `Promise.all` | Both rows exist; sequence order matches the chain; the second `prev_hash` equals the first `hash`; no duplicate link | 03-01 §Writer, AR-10 |
| ST-12 | Record two events with identical business fields | Different `event_id`, `ts`, `hash`, and `hmac`; both retained | 03-01 §Writer |
| ST-13 | Record after a key already exists | The existing key id is reused; `audit_keys` still has one row | 03-01 §Audit Key Store, AR-9 |
| ST-14 | Record while the keyring does not contain the row's KEK | Throws `AuditKeyUnavailableError`; no `audit_events` row | 03-01 §Audit Key Store, AR-9 |
| ST-15 | Record 1,001 events with the default cadence | Checkpoints exist at the first event and at event 1,001; no checkpoint at event 1,000 | 03-01 §Checkpoints, AR-11 |
| ST-16 | Record one event, advance the injected clock 24 hours, record another | A checkpoint is written at the second event | 03-01 §Checkpoints, AR-11 |
| ST-17 | Record with a `details` key not in the action allowlist, e.g. `token` | Throws `AuditInputError`; no row | 03-01 §Action Catalog, AR-16 |
| ST-18 | Record with 17 KiB of details | Throws `AuditInputError`; no row | 03-01 §Action Catalog, AR-16 |
| ST-19 | Record a mutation inside a transaction that throws | No mutation row exists; the assignment row is unchanged | 03-01 §Writer, AR-17 |
| ST-20 | Record a policy denial inside a transaction that throws | Exactly one decision row exists with the pre-mutation policy version | 03-01 §Persistent Policy Adapter, AR-10, AR-17 |
| ST-21 | Record a decision with `scopeType = "system"` | Row has `scope_type = 'system'`, `project_id = NULL`, `scope_id = NULL`, `result` preserved | 03-01 §Persistent Policy Adapter, AR-6 |
| ST-22 | Record a mutation with object scope | Row has `project_id` equal to the owning project's id | 03-01 §Persistent Policy Adapter, AR-18 |

### Query and Cursor

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-23 | Three events, query with no filters and default limit | `events` in descending sequence order; `nextCursor` null | 03-02 §Query Service, AR-13 |
| ST-24 | Three events, `limit=2` | Two events and a non-null `nextCursor`; the cursor page returns the third and null | 03-02 §Cursor, AR-13 |
| ST-25 | Filter `result=deny` | Only deny rows | 03-02 §Query Service |
| ST-26 | Filter `action=identity.create` | Only that action | 03-02 §Query Service |
| ST-27 | Filter `from` and `to` enclosing one event | That event only; boundaries are inclusive | 03-02 §Query Service, AR-13 |
| ST-28 | Combined `actorId`, `objectType`, and `objectId` filters | Only the matching rows | 03-02 §Query Service |
| ST-29 | Use a valid cursor with a different `action` filter | 422 `validation_error`; no rows returned | 03-02 §Cursor, AR-13 |
| ST-30 | Tamper with one cursor character | 422 `validation_error` | 03-02 §Cursor, AR-13 |
| ST-31 | `limit=0` or `limit=501`; `objectId` without `objectType` | 422 `validation_error` | 03-02 §Public Contracts, AR-13 |
| ST-32 | Project auditor queries without a project filter | Only rows for granted projects; another project's row and org/system rows are absent | 03-02 §Authorization, AR-14 |
| ST-33 | Project auditor queries a project outside the grant | 403 `access_denied`; no rows | 03-02 §Authorization, AR-14 |

### Verification

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-34 | Verify a clean chain | `ok: true`; `checkedRange` covers the first through last event; `reason: "ok"` | 03-02 §Verify Service, AR-12 |
| ST-35 | Edit the first retained event's `result` while its checkpoint exists, with triggers disabled | `ok: false`; `firstBrokenEventId` is that event; `reason: "hash_mismatch"`; the anchor event is rehashed, not trusted from its stored hash; one `audit.verify` event with result `error` | 03-02 §Verify Service, AR-12, AR-17 |
| ST-36 | Edit an event's `details` with triggers disabled | `ok: false` at that event; `reason: "hash_mismatch"` | 03-02 §Verify Service, AR-12 |
| ST-37 | Edit an event's `hash` with triggers disabled | `ok: false` at that event; `reason: "hash_mismatch"` | 03-02 §Verify Service, AR-12 |
| ST-38 | Delete a middle event with triggers disabled | `ok: false` at the next retained event; `reason: "prev_hash_mismatch"` | 03-02 §Verify Service, AR-12 |
| ST-39 | Record 1,001 events so the latest checkpoint anchors the tail, delete the last event with triggers disabled, then add a newer checkpoint | `ok: false`; `reason: "tail_truncated"`; the older checkpoint is still checked, so a newer checkpoint cannot mask the deletion; `firstBrokenEventId` null | 03-02 §Verify Service, AR-12 |
| ST-40 | Remove all checkpoints and delete the genesis event | `ok: false`; `reason: "missing_checkpoint"` at the first retained event | 03-02 §Verify Service, AR-12 |
| ST-41 | Verify an empty chain with no checkpoints | `ok: true`; `checkedRange: null`; `reason: "empty_chain"` | 03-02 §Verify Service, AR-12 |
| ST-42 | Project auditor calls verify | 403 `access_denied`; no chain details | 03-02 §Authorization, AR-14 |
| ST-43 | Org auditor calls verify | 200; one `audit.read` allow event and one `audit.verify` event | 03-02 §Authorization, AR-1, AR-14 |
| ST-92 | Remove the KEK that unwraps one event's audit key and the latest checkpoint's key, then verify | `ok: false`; `firstBrokenEventId` is the event whose key is missing, or null for a checkpoint-level failure; `reason: "key_unavailable"`; no checkpoint is skipped | 03-02 §Verify Service, AR-12 |
| ST-96 | Empty `audit_events` table with a surviving checkpoint | `ok: false`; `checkedRange: null`; `firstBrokenEventId: null`; `reason: "tail_truncated"` | 03-02 §Verify Service, AR-12 |

### Export

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-44 | Export three events with no filter | Three NDJSON lines; each parses as the public event schema; `Content-Type: application/x-ndjson` | 03-02 §Export Service, AR-15 |
| ST-45 | Export with the same filters as a list query | The exported event ids equal the listed ids in ascending order | 03-02 §Export Service, AR-15 |
| ST-46 | Export once | Exactly one `audit.export` event with `format: "ndjson"` and the normalized filters | 03-02 §Export Service, AR-15 |
| ST-47 | Force the export audit write to fail | 503 before headers; no NDJSON body | 03-02 §Export Service, AR-17 |
| ST-48 | Export 600 events | 600 lines; memory stays bounded by the 500-row batch | 03-02 §Export Service, AR-15 |

### Policy and Identity Emitters

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-49 | Successful `identity.create` | Exactly one allow decision with action `identity.create`, object type `project` | 03-03 §Identity, AR-19 |
| ST-50 | Successful `identity.revoke` | Exactly one allow decision with object type `identity` and the identity id | 03-03 §Identity, AR-19 |
| ST-51 | Denied `identity.revoke` | Exactly one deny decision; no duplicate `hasAny` event; 403 or 404 per visibility | 03-03 §Identity, AR-19 |
| ST-52 | Successful join-token issue | Exactly one allow decision with action `identity.join_token` | 03-03 §Identity, AR-19 |
| ST-53 | Successful assignment grant | One `assignment.write` allow decision plus one `assignment.grant` mutation with `projectId`, `objectType: "assignment"`, and `objectId` equal to the assignment id | 03-03 §Policy Adapter, AR-1, AR-18 |
| ST-54 | Denied assignment grant | One allow/deny decision; no mutation event | 03-03 §Policy Adapter, AR-1 |
| ST-55 | Last-org-admin revoke denial | One deny decision with reason `last_org_admin`; no mutation event | 03-03 §Policy Adapter, AR-1 |

### Authentication Emitters

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-56 | Browser local login with valid credentials | One `auth.login` allow; `method=local`, `client=browser`, actor id set; no password field; no deny event | 03-03 §Authentication, AR-20 |
| ST-57 | Unknown identifier | One `auth.login` deny; `actorKind=system`, actor null, reason `unknown_credentials`; HTTP 401 generic | 03-03 §Authentication, AR-20 |
| ST-58 | Wrong password five times | Five deny events; the fifth also writes one `auth.lockout` with `lockSeconds=900` | 03-03 §Authentication, AR-20 |
| ST-59 | Login while already locked | One deny with reason `locked`; no new `auth.lockout` | 03-03 §Authentication, AR-20 |
| ST-60 | CLI local login success | One allow with `client=cli`; no deny event | 03-03 §Authentication, AR-20 |
| ST-61 | OIDC success | One allow with `method=oidc`; no subject or token in details | 03-03 §Authentication, AR-20 |
| ST-62 | OIDC state failure, provider error, exchange failure, access denial | One deny each with `oidc_flow`, `oidc_flow`, `oidc_flow`, or `access_denied`/`link_collision` | 03-03 §Authentication, AR-20 |
| ST-98 | Credential changes after verification but before delivery (browser and CLI) | Exactly one `auth.login` deny with `invalid_credentials`; no allow event; no session or token returned | 03-03 §Authentication, AR-20 |

### Agent and Consumer Emitters

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-63 | First successful join | One `agent.join` allow; service actor; one `consumer.register`; details contain the certificate serial and no token | 03-03 §Agent Join, AR-21, AR-22 |
| ST-64 | Join with an unknown token | One `agent.join` deny; system actor; reason `join_token_unknown` | 03-03 §Agent Join, AR-21 |
| ST-65 | Join with an expired token | One deny; system actor; reason `join_token_expired` | 03-03 §Agent Join, AR-21 |
| ST-66 | Join with a used token | One deny; service actor equal to the token principal; reason `join_token_used` | 03-03 §Agent Join, AR-21 |
| ST-67 | Join with a revoked token | One deny; service actor; reason `join_token_revoked` | 03-03 §Agent Join, AR-21 |
| ST-68 | Join with an inactive principal or deleted project | One deny; system actor; reason `principal_inactive` or `project_inactive` | 03-03 §Agent Join, AR-21 |
| ST-69 | Join with an invalid CSR | One deny; system actor; reason `invalid_csr` | 03-03 §Agent Join, AR-21 |
| ST-70 | Successful renewal with changed compose service | One `agent.renew` allow and one `consumer.update` with `changed=["composeService"]`; a replay of the same request writes no additional event | 03-03 §Consumer, AR-22 |
| ST-71 | Rejoin with unchanged metadata | One `agent.join` allow; no `consumer.register` or `consumer.update` | 03-03 §Consumer, AR-22 |
| ST-72 | Renewal changes state from `degraded` to `ok` | One `consumer.update` with `changed=["state"]` | 03-03 §Consumer, AR-22 |
| ST-73 | Renewal fails because it is not due | One `agent.renew` deny; service actor; reason `renewal_not_due`; the event is written after the transaction rolls back and survives | 03-03 §Agent Renewal, AR-21 |

### Prune

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-74 | Events from 200 days ago and today; prune with 180-day retention | Prune verifies the retained chain first; old prefix exported as NDJSON; checkpoint at the prefix's last event; old rows deleted; recent rows retained; verify returns `ok` | 03-04 §Prune Service, AR-23 |
| ST-75 | Prune with `--dry-run` | Export file written; checkpoint written; no rows deleted; `audit.prune` has `dryRun=true` and `deletedCount=0` | 03-04 §Prune Service, AR-23 |
| ST-76 | Prune with no rows older than retention | `audit.prune` with zero counts; no boundary checkpoint change; exit 0 | 03-04 §Prune Service, AR-23 |
| ST-77 | Missing `OPENVAULT_PRUNE_DB_URL` | Error before any file or database write; exit 1 | 03-04 §Prune Connection, AR-4 |
| ST-78 | Relative output path | Usage error; exit 2; no file | 03-04 §CLI, AR-23 |
| ST-79 | Output path already exists | Error; existing file unchanged | 03-04 §CLI, AR-23 |
| ST-80 | Delete as the application role | Trigger rejects with `audit rows are append-only` | 03-04 §Prune Connection, AR-4 |
| ST-81 | Delete through the pruner connection with `SELECT, DELETE` grants and the setting on | Rows deleted; no trigger error | 03-04 §Prune Connection, AR-4 |
| ST-93 | Pre-create a boundary checkpoint with a bad HMAC, then prune | Abort before delete; the prefix remains | 03-04 §Prune Service, AR-23 |
| ST-95 | Prune every event, leaving only the prune event | The prune event's `prev_hash` equals the boundary checkpoint's `lastHash`; verify returns `ok`; a later normal event also links to the checkpoint hash and verifies | 03-04 §Prune Service, AR-23 |
| ST-97 | Tamper a prefix event with triggers disabled, then prune | Abort before export, checkpoint, or delete; the prefix remains; `audit.prune` is not written | 03-04 §Prune Service, AR-23 |

### Checkpoint Export

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-88 | Export the latest checkpoint | JSON contains `id`, `lastEventId`, `lastHash`, `hmac`, `auditKeyId`, and `createdAt`; hashes are lowercase hex; file mode is `0600` | 03-04 §Checkpoint Export Command, AR-27 |
| ST-89 | Export to an existing path | Error; the existing file is unchanged | 03-04 §Checkpoint Export Command, AR-27 |
| ST-90 | Export when no checkpoint exists | Error with a clear message; no file | 03-04 §Checkpoint Export Command, AR-27 |

### Security and Redaction

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-82 | Force the audit writer to fail during a test-only secret read | 503 `service_unavailable`; the sentinel plaintext is not returned | 03-03 §Fail-Closed Behavior, AR-17 |
| ST-83 | Run every emitter with sentinel values in passwords, tokens, CSRs, cookies, and secret values | No column of any `audit_events` row contains a sentinel | 03-01 §Action Catalog, AR-16 |
| ST-84 | Attempt to record `details` with `privateKey`, `csr`, `password`, `token`, or `cookie` | `AuditInputError`; no row | 03-01 §Action Catalog, AR-16 |
| ST-85 | Verify the audit action catalog | Every `RBAC_ACTIONS` value is in `AUDIT_ACTIONS`; the public query schema accepts each | 03-01 §Action Catalog, AR-5 |
| ST-86 | Record an event with a user agent over 512 characters | Stored value is truncated to 512 characters; no insert failure | 03-01 §Hash and HMAC, AR-8 |
| ST-87 | Read an event through the API | Hashes are 64 lowercase hex characters; `eventId` is a ULID; `projectId` is present or null | 03-02 §Public Contracts, AR-6 |
| ST-91 | Record with `sourceIp` `"2001:0db8::1"` | Stored and returned value is the canonical `"2001:db8::1"`; the chain verifies | 03-01 §Writer, AR-8 |
| ST-94 | Force the audit insert to fail on a wrong-password login | 503; no session cookie; no allow event; the credential failure counter may be one higher | 03-03 §Error Handling, AR-17 |

## Test Categories

### Specification Tests

| Test file | ST cases | Component |
|---|---|---|
| `apps/server/tests/audit/canonical-json.spec.test.ts` | ST-1–ST-8 | Canonical JSON and hashing |
| `apps/server/tests/integration/audit-chain.spec.test.ts` | ST-9–ST-22, ST-91 | Writer, keys, checkpoints, policy adapter |
| `apps/server/tests/integration/audit-query.spec.test.ts` | ST-23–ST-33 | Query, cursor, authorization |
| `apps/server/tests/integration/audit-verify.spec.test.ts` | ST-34–ST-43, ST-92, ST-96 | Verification and verify authorization |
| `apps/server/tests/integration/audit-export.spec.test.ts` | ST-44–ST-48 | NDJSON export |
| `apps/server/tests/integration/audit-emitters.spec.test.ts` | ST-49–ST-55 | Policy and identity emitters |
| `apps/server/tests/integration/audit-auth.spec.test.ts` | ST-56–ST-62, ST-98 | Authentication emitters |
| `apps/server/tests/integration/audit-agent.spec.test.ts` | ST-63–ST-73 | Agent and consumer emitters |
| `apps/server/tests/integration/audit-prune.spec.test.ts` | ST-74–ST-81, ST-88–ST-90, ST-93, ST-95, ST-97 | Retention, prune, checkpoint export |
| `apps/server/tests/integration/audit-security.spec.test.ts` | ST-82–ST-87, ST-94 | Fail-closed, redaction, contracts |

### Implementation Tests

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/integration/audit-chain.impl.test.ts` | Advisory-lock serialization, sequence gaps, checkpoint boundary, key reuse, timestamp round-trip | High |
| `apps/server/tests/audit/canonical-json.impl.test.ts` | Key ordering, escaping edge cases, depth and size guards | High |
| `apps/server/tests/integration/audit-query.impl.test.ts` | Dynamic clause assembly, empty pages, cursor key rotation, visibility changes | High |
| `apps/server/tests/integration/audit-verify.impl.test.ts` | Batch boundaries, multiple checkpoints, unavailable early key, anchor selection | High |
| `apps/server/tests/integration/audit-export.impl.test.ts` | Backpressure, client disconnect, mid-stream error | Medium |
| `apps/server/tests/integration/audit-emitters.impl.test.ts` | Event counts across every identity and policy method, denial counter | High |
| `apps/server/tests/integration/audit-auth.impl.test.ts` | Authentication reason and lockout matrix | High |
| `apps/server/tests/integration/audit-agent.impl.test.ts` | Agent failure matrix, consumer change detection | High |
| `apps/server/tests/integration/audit-security.impl.test.ts` | Sentinel redaction, forced audit failures, no state change | High |
| `apps/server/tests/integration/audit-prune.impl.test.ts` | Role guard, partial-file cleanup, checkpoint idempotence, wrong URL | Medium |
| `apps/server/tests/integration/audit-rate-limits.impl.test.ts` | Separate buckets, principal key, threshold overrides | Medium |

### Integration Tests

The specification and implementation files above are integration tests because they use a disposable PostgreSQL database and the real application. No separate integration layer is needed.

### End-to-End Tests

The HTTP route tests exercise the full path: TLS-less in-process application, auth middleware, policy engine, writer, PostgreSQL, and response envelope. A real listener E2E test is not added: the existing transport suite already covers listener behavior, and repeating it for audit would add no coverage. This is `N/A` for a new harness, not for behavior.

## Test Data

### Fixtures

- A disposable database per file, migrated with the existing harness.
- `seedBase` without synthetic audit rows (AR-26). A separate `seedAuditFixture` supplies the schema-only random rows for the schema test.
- A keyring with one KEK (`k1`) from `createServerEnvironment`.
- Directly seeded org admin, project admin, auditor, and project rows, following the RD-06 test pattern.
- A deterministic clock for cadence and prune tests.
- The pruner role from `ensurePrunerRole`, with `SELECT, DELETE`, when the test user is a superuser.

### Mocks

- The existing fake OIDC provider is the only external mock.
- No database mock; the real adapter proves SQL, constraints, and triggers.
- No crypto mock; real Node crypto proves the chain.
- A `RecordingAudit` fake is used only for isolated unit tests that do not need persistence.

### Tamper Tests

The append-only trigger prevents normal UPDATE and DELETE. Tamper tests disable the specific trigger as the superuser test role, perform the mutation, and restore the trigger in `finally`. This simulates a database administrator with table access, which is the threat model in `docs/security/threat-model.md`. The prune tamper test also asserts that `AuditPruner` calls the verifier before export, checkpoint, or delete.

## Verification Checklist

- [ ] All specification test cases (ST-*) defined with concrete input/output pairs
- [ ] Every ST case traces to a requirement, spec doc, or AR entry
- [ ] Specification tests written BEFORE implementation
- [ ] Specification tests verified to FAIL before implementation (red phase)
- [ ] All specification tests pass after implementation (green phase)
- [ ] Implementation tests written for edge cases and internals
- [ ] Verification includes the first retained anchor event and every checkpoint at or after the window
- [ ] Prune verifies the retained chain before export, checkpoint, or delete
- [ ] Credential races write one deny event and no allow event
- [ ] All unit and integration tests pass on PostgreSQL 16 and 17
- [ ] No regressions in existing tests
- [ ] `pnpm verify` passes
- [ ] `pnpm db:types:check` passes with no generated-type drift
- [ ] `pnpm docs:build` passes
- [ ] `pnpm changeset status` shows the audit changeset
- [ ] No spec test expectation was changed to match the implementation
