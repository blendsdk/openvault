# Testing Strategy: RD-08 Projects and Secrets

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Contracts and crypto | 95% |
| Project repository and service | 90% |
| Secret repository, envelope, and service | 90% |
| Lifecycle and purge | 90% |
| Controllers and wiring | 85% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL, the real keyring, real AES-GCM, and real
  transactions. Only time and the purge-role availability may be substituted.
- Every specification case below is derived from RD-08, the component documents, or the
  Ambiguity Register. Expectations are not derived from the implementation.

## 🚨 Specification Test Cases

### Contracts and Envelope

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | `projectCreateRequestSchema.parse({ name: "payments" })` | Accepted; no display name exists | AR-4 |
| ST-2 | `projectCreateRequestSchema.safeParse({ name: "Payments" })` | Fails; uppercase is not allowed | RD-08 project name |
| ST-3 | `projectUpdateRequestSchema.safeParse({})` | Fails; the name is required | AR-4 |
| ST-4 | `secretCreateRequestSchema.parse({ name: "db-password", value: "x" })` | `encoding` is `utf8`, `contentType` is `text/plain`, `tags` is `{}` | AR-5 |
| ST-5 | `secretMetadataSchema.safeParse` on a response with a `value` key | Fails; metadata is strict and has no value field | RD-08 metadata rule |
| ST-6 | `secretTagsSchema.safeParse` with 16 pairs | Fails the 15-pair limit | RD-08 limits |
| ST-7 | `secretListQuerySchema.parse({})` | `limit` defaults to 50 | AR-10 |
| ST-8 | `secretListQuerySchema.safeParse({ limit: 101 })` | Fails the 1–100 bound | AR-10 |
| ST-9 | `secretListQuerySchema.safeParse({ tagValue: "prod" })` | Fails; `tagKey` is required with `tagValue` | AR-10 |
| ST-10 | Encrypt with `objectType: "secret"`, decrypt with the same AAD | Returns the original bytes | AR-7 |
| ST-11 | Encrypt with `objectType: "secret"`, decrypt with `objectType: "certificate"` | Throws `CryptoIntegrityError` | AR-7 |
| ST-12 | Encrypt with one project/object/version, decrypt with another | Throws `CryptoIntegrityError` | AR-7 |
| ST-13 | Decrypt an envelope with a non-canonical base64 field | Throws `CryptoInputError` before key lookup | AR-7 |
| ST-14 | Decrypt an envelope with an unknown field or a wrong-length field | Throws `CryptoInputError` | AR-7 |
| ST-15 | Decrypt ciphertext above the supplied limit | Throws `CryptoInputError` | AR-7 |
| ST-16 | Decrypt an envelope with a non-ULID AAD field | Throws `CryptoInputError` | AR-7 |
| ST-17 | Use `KeyringProvider` as `EnvelopeKeyring` | Encrypt/decrypt round-trip succeeds | AR-7 |

### Projects

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-18 | Org admin creates `{ name: "payments" }` | 201; id is a ULID; one `project.create` allow decision with objectType `project` and the new id | RD-08 project create |
| ST-19 | Create a second project with the same active name | 409 `project_name_conflict`; one project row remains; no allow event from the failed attempt | AR-4, AR-17 |
| ST-20 | Project-scope reader lists projects | Only the project ids in the reader's grants are returned | AR-3 |
| ST-21 | Org admin renames a project to a free name | 200 with the new name; `updated_at` changes | AR-20 |
| ST-22 | Org admin soft-deletes a project | 204; the row remains with `deleted_at`; a repeat delete returns 404 | AR-2 |
| ST-23 | After project delete, read the project, list its assignments, access-explain one of its secrets, and create an object-scope assignment on it | Project is 404; assignment list hides it; access-explain is 404; assignment create is 404 | AR-3, AR-27 |
| ST-24 | A project-scoped `project.admin` updates a different project | 404 `project_not_found` | AR-3 |
| ST-25 | A project admin tries to delete its own project | 403 `access_denied` because only `org.admin` has `project.delete` | RD-06 role matrix |
| ST-26 | An unknown or deleted project id on the admin route | 404 `project_not_found` | AR-2 |
| ST-27 | A project-scope reader requests a project outside its grant | 404 `project_not_found` | AR-3 |

### Secret Write and Read

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-28 | Create a secret with a 65,536-byte UTF-8 value, read it back | 201; one version row; exact bytes returned; one decision event; no value in the metadata/event | RD-08 acceptance 1 |
| ST-29 | Create a secret with a 65,537-byte value | 413 `secret_too_large`; no secret row; no allow event | RD-08 acceptance 1 |
| ST-30 | Create a legitimate 64 KiB value containing many quotes, backslashes, and newlines | 201; the request passes the data body guard; exact bytes returned | AR-25 |
| ST-31 | Create a secret with `""` or `"   "` | 422 `validation_error`; no row | RD-08 acceptance 2 |
| ST-32 | Create base64 values that decode to empty or all whitespace | 422 `validation_error`; no row | AR-6 |
| ST-33 | Create a secret with invalid base64 (`"abc"`) | 422 `validation_error`; no row | AR-6 |
| ST-34 | Create with `encoding: "base64"` and a valid binary value | 201; read returns the same bytes with `encoding: "base64"` | AR-6 |
| ST-35 | Put a new value twice | Two versions; current version is the second; the first remains readable by id | RD-08 acceptance 3 |
| ST-36 | List secrets | No item contains a `value` field; each item has tags, currentVersion, timestamps, status, consumers, and capabilities | RD-08 acceptance 4 |
| ST-37 | Create names containing `/`, `..`, a control character, or a Unicode look-alike | All return 422; no row | RD-08 acceptance 5 |
| ST-38 | Create a secret whose name matches a deleted secret | 409 `secret_name_conflict`; the deleted row is untouched | AR-19 |
| ST-39 | Read a value without `secret.read` anywhere | 403 `access_denied`; no value in the response | RD-08 acceptance 10 |
| ST-40 | Read or list a secret in another project as a project-scope reader | 404 `secret_not_found` / `project_not_found`; no metadata or value | RD-08 acceptance 10 |
| ST-41 | An object-scope-only reader reads its value, lists, and requests versions/consumers | Value read succeeds; list returns 403; versions/consumers succeed | AR-16 |
| ST-42 | Create with `contentType: "application/octet-stream"` and `tags: { env: "prod" }` | Metadata round-trips both fields | RD-08 tags |
| ST-43 | PATCH tags and content type | Metadata changes; the version list length is unchanged | RD-08 metadata rule |
| ST-44 | PATCH with an empty body | 422 `validation_error` | AR-5 |
| ST-45 | Create with a past or equal `expiresAt` | 422 `validation_error`; no row | AR-9 |
| ST-46 | Search with `q` containing `%`/`_`, filter by `tagKey`/`tagValue`, and continue with a cursor | Literal search; exact tag match; next page starts after the cursor | AR-10 |
| ST-47 | Send a malformed cursor (bad base64 or JSON shape) | 422 `validation_error` | AR-10 |

### Idempotency

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-48 | POST twice with the same `Idempotency-Key` and body | Both return the same secret/version; one secret row and one version row exist | RD-08 acceptance 6 |
| ST-49 | PUT twice with the same `Idempotency-Key` and body | Both return the same `version`; exactly one new version row exists | AR-11 |
| ST-50 | PUT V1 with a key, then PUT V2, then replay V1's key | The replay returns current metadata plus V1 in `version`, not the current V2 | AR-11 |
| ST-51 | Reuse a key for a different body | 409 `idempotency_conflict`; no new version | AR-11 |
| ST-52 | Reuse a key for a different path or method | 409 `idempotency_conflict`; no new version | AR-11 |
| ST-53 | Reuse a key after 24 hours | The new request is accepted; one row is replaced with the new status and version | AR-11 |
| ST-54 | Replay a key after the secret was purged | 404 `secret_not_found` | AR-11 |
| ST-55 | Invalid key (empty, 201 characters, control character) | 422 `validation_error` | AR-11 |
| ST-56 | Inspect `idempotency_keys.request_hash` after a create | The plaintext value cannot be recovered or verified by hashing guesses; the hash is a KEK HMAC | AR-30 |

### Lifecycle, Expiry, and Purge

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-57 | Delete a secret | 204; read/list hide it; `deleted_at` and `purge_after` use the database clock and the retention value | RD-08 acceptance 7 |
| ST-58 | Recover a deleted secret before retention | 200; read works again; `deleted_at` and `purge_after` are null | RD-08 acceptance 7 |
| ST-59 | Recover at/after the retention boundary | 409 `secret_not_recoverable`; the row remains deleted | AR-13 |
| ST-60 | Purge before retention | 409 `secret_retention_active`; no rows are deleted | RD-08 acceptance 7 |
| ST-61 | Enable protection on an active secret, delete it, age it past retention, then purge | Enable returns 200; delete returns 204; purge returns 409 `purge_protection_locked` | RD-08 acceptance 8 |
| ST-62 | Attempt to disable protection (true→false) and set false on an unprotected secret | True→false is 409; false→false is a no-op 200 | RD-08 acceptance 8 |
| ST-63 | Delete, wait past retention, purge without protection | 204; version and parent rows are gone; a later create with the same name succeeds | RD-08 acceptance 7 |
| ST-64 | Purge without `OPENVAULT_PURGE_DB_URL` | 503 `service_unavailable`; no rows deleted; exactly one error outcome exists and no allow | AR-14, AR-32 |
| ST-65 | Purge with the application role or a wrong database | 503 `service_unavailable`; no rows deleted | AR-28 |
| ST-66 | Read an expired current version while an older version is active | The older active version is returned | AR-8 |
| ST-67 | Read an expired current version when every version is expired | 410 `secret_expired`; exactly one error outcome exists and no allow | AR-8, AR-32 |
| ST-68 | Read an expired named version while a newer version is active | 410 `secret_expired`; the newer read still succeeds | AR-8 |
| ST-69 | Write after the current version expired | A new current version is created; the old version remains expired | AR-8 |
| ST-70 | Force the audit writer to fail during a create | 503; no secret, version, idempotency row, or allow event remains | RD-08 acceptance 9 |
| ST-71 | Force the audit writer to fail during a value write | 503; the current version, version count, and allow-event count are unchanged | RD-08 acceptance 9 |
| ST-72 | Force the audit writer to fail during a value read | 503; no value, version, or allow event is returned | AR-17 |
| ST-73 | Create 1,000 retained versions and one more | The 1,000th write succeeds; the next returns 409 `secret_version_limit` with no row/allow | AR-12 |
| ST-74 | Create 1,000 retained versions including expired ones, then write | The write returns 409 because retained rows are the limit | AR-12 |
| ST-75 | Project-scope reader lists or reads another project's secret | 404; no metadata or value | RD-08 acceptance 10 |

### Consumers and Capabilities

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-76 | A project has active consumers with project-scope `secrets.reader`, `secrets.officer`, and `secrets.manager` grants | All three appear in secret metadata consumers with Compose names and lastSeen | RD-08 acceptance 12, AR-15 |
| ST-77 | A consumer has no `secret.read` grant, an expired grant, or an inactive principal | It is absent from the secret consumers | AR-15 |
| ST-78 | A consumer state is `degraded` or `failed` | It remains listed; the state is not filtered | AR-15 |
| ST-79 | The consumer projection runs | No hostname or manifest hash is returned | RD-08 acceptance 12 |
| ST-80 | Org admin, project admin, secrets manager, officer, secrets reader, auditor, and reader request a secret or list | Capability flags match the evaluator for each role; roles without `secret.read` still see list flags | RD-08 acceptance 11 |
| ST-81 | A list of 100 secrets is returned | Each item has the five flags; the service loaded one actor snapshot | AR-16 |

### API and Wiring

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-82 | `GET /v1/data/payments/secrets/db-password` with a browser cookie | 200 with the value and capabilities; the decision event exists | AR-21 |
| ST-83 | The same route on the agent listener with a valid agent certificate | 200; the actor is the agent principal; the decision event exists | AR-21 |
| ST-84 | A data route other than the value read on the agent listener | 401 `authentication_required` | AR-21 |
| ST-85 | Invalid JSON body or an unknown field | 400/422 with the stable envelope; no value in the error | API reference |
| ST-86 | 601 data requests from one principal in a minute | The last request returns 429 | AR-18 |
| ST-87 | A sentinel plaintext after create/read/update/delete/purge/deny/error | The sentinel is absent from every response body/header, audit event and details, and captured log | AR-3, AR-22 |
| ST-88 | Delete a protected secret, then try to create the same name | 409 `secret_name_conflict`; a protected deleted name is reserved forever | AR-13, AR-19 |
| ST-89 | A valid agent value read | 200; `consumers.last_seen` is updated; no audit event is created for the timestamp | AR-21, RD-10 |
| ST-90 | After project delete, read a secret value/list, read an identity, and resolve a certificate object | All return 404/hidden; no value or metadata leaks | RD-08 acceptance 4 |
| ST-91 | A caller with no write grant probes an existing and a missing secret name on create | Both return the same 403/404 outcome; no `secret_name_conflict` oracle | AR-19 |
| ST-92 | A retry of a successful create or PUT after the secret was soft-deleted | The idempotency replay returns the stored version; no 404/409 lifecycle error | AR-11 |

## Test Categories

### Specification Tests

| Test file | ST cases | Component |
|---|---|---|
| `packages/api-contract/tests/projects.spec.test.ts` | ST-1..3 | Project contracts |
| `packages/api-contract/tests/secrets.spec.test.ts` | ST-4..9 | Secret contracts |
| `packages/core/tests/envelope-aad.spec.test.ts` | ST-10..17 | Crypto and keyring |
| `apps/server/tests/integration/projects.spec.test.ts` | ST-18..27 | Projects and visibility |
| `apps/server/tests/integration/secrets.spec.test.ts` | ST-28..47, ST-76..81 | Secret write/read/list/consumers/capabilities |
| `apps/server/tests/integration/secrets-idempotency.spec.test.ts` | ST-48..56 | Idempotency |
| `apps/server/tests/integration/secrets-lifecycle.spec.test.ts` | ST-57..75, ST-87 | Lifecycle, expiry, purge, leakage |
| `apps/server/tests/integration/secrets-http.spec.test.ts` | ST-82..86 | HTTP routes, auth modes, limits |

### Implementation Tests

| Test file | Description | Priority |
|---|---|---|
| `apps/server/tests/integration/projects.impl.test.ts` | Concurrent rename, delete idempotence, hidden assignment snapshot | High |
| `apps/server/tests/integration/secrets.impl.test.ts` | Envelope mapping, malformed ciphertext, cursor continuation, wildcard search, active-version limit | High |
| `apps/server/tests/integration/secrets-lifecycle.impl.test.ts` | Purge role/database guards, transaction failure, name reservation, concurrent delete/recover | High |
| `packages/api-contract/tests/projects.impl.test.ts` | Unknown fields, name bounds | Medium |
| `packages/api-contract/tests/secrets.impl.test.ts` | Tag key/value bounds, control characters, base64 schema edges | Medium |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Project hide chain | Projects, secrets, policy, assignments, explain | Delete a project and verify every dependent surface is hidden |
| Joined audit rollback | Secrets, audit, idempotency | Force a writer failure and verify no state or allow event |
| Concurrent value writes | Secrets, audit, PostgreSQL | Two writes serialize into two versions and one chain |
| Agent value read | Agent middleware, policy, secrets | A real certificate principal reads its project's secret |
| Concurrent project delete vs create | Projects, secrets | The writer either commits before the delete or fails after it; no hidden write |
| Concurrent rename vs decision | Projects, audit | A rename and an independent audit decision complete without deadlock |
| Concurrent purge vs project delete | Secrets, projects, purge | The purge and delete serialize; the purge cannot delete into a deleted project |

### End-to-End Tests

N/A — the CLI and UI are RD-11 and RD-12. The HTTP integration suite is the end-to-end boundary
for this plan.

## Test Data

### Fixtures Needed

- A migrated disposable database per test file and a real keyring.
- An org admin, project admin, secrets manager, secrets officer, secrets reader, auditor,
  plain reader, and service identities with consumer rows.
- Two projects with active readers, one soft-deleted project, and object-scope readers.
- A disposable `openvault_purger` role with `SELECT` on `projects` and `SELECT, DELETE` on
  `secrets` and `secret_versions`, provisioned when the maintenance user is a superuser.

### Mock Requirements

- No crypto or database mocks. The clock and the purge URL may be injected.
- The audit writer may be wrapped only to force a storage failure in the rollback tests.
- The app logger may capture records through the existing `loggerDestination` test seam.
- The policy repository may be wrapped with a counter only to prove one actor snapshot per
  list request.

## Verification Checklist

- [ ] All specification cases (ST-*) are defined with concrete input/output pairs.
- [ ] Every ST case traces to an RD, spec doc, or AR entry.
- [ ] Specification tests are written before implementation.
- [ ] The red phase is recorded for every phase.
- [ ] All specification tests pass after implementation.
- [ ] Implementation tests cover edge cases and internals.
- [ ] `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, and the full integration
  suite pass.
- [ ] No regressions in the RD-06/RD-07 suites.
