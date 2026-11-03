# Testing Strategy: RD-06 RBAC

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Action/role catalog and contracts | 95% |
| Policy evaluator and scope matching | 95% |
| Assignment service, grant guards, last-admin | 95% |
| Access explain, catalog routes, rate limits | 90% |
| Audit port and logger adapter | 95% |
| Documentation and changeset | docs build + link check |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Integration tests use real PostgreSQL through the disposable-database helper, real migrations,
  real HTTPS listeners for HTTP routes, and the real policy service. There are no database or
  policy mocks.
- The only test doubles are a recording audit port (to count events), a failing audit port (to
  prove fail-closed behavior), and an injectable clock for expiry boundaries.
- End-to-end tests are **N/A**: RD-06 has no UI or CLI surface. The HTTP integration tests cover
  the complete server boundary.
- In-code traceability comments quote behavior in plain language. They never include an `ST-` id,
  an RD id, a plan path, or a requirements path.

## 🚨 Specification Test Cases

### Catalog and contracts

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Read the encoded action catalog | Exactly 25 actions in the published order; 12 control-plane and 13 data-plane; every action has a non-empty description | RD-06 Action catalog; `docs/reference/roles.md` §Actions |
| ST-2 | Read the encoded role matrix | Exactly nine roles; every role/action pair matches the published matrix; no role contains an unknown action | RD-06 Role matrix; `docs/reference/roles.md` §Role matrix |
| ST-3 | Read the encoded scope eligibility | `org.admin` org-only; object scope only for `secrets.reader` and `certificates.reader`; all other entries match the published table | RD-06 Scope eligibility; `docs/reference/roles.md` §Scope eligibility |
| ST-4 | `GET /v1/meta/roles` without a session | 200; `actions`, `roles`, and `policyVersion`; no assignments, principal ids, project ids, or secrets | RD-06 Must Have; AR-11, AR-24 |
| ST-5 | POST assignment with an unknown field, a missing field, or a non-ULID principal | 422 `validation_error`; no assignment row | AR-6, AR-27 |
| ST-6 | POST assignment with `scopeType=org` and `scopeId!=org`; project/object with a non-ULID scope id | 422 `validation_error`; no row | AR-6, AR-27 |
| ST-7 | POST assignment with `expiresAt` in the past, an invalid timestamp, or absent | Past/invalid → 422; absent → 201 with `expiresAt: null` | AR-14 |
| ST-8 | GET assignments with an unknown query field or an invalid role | 422 `validation_error`; no data returned | AR-15, AR-27 |
| ST-9 | GET access-explain without `action`; org with a non-org id; project/object without a ULID | 422 `validation_error` | AR-5, AR-27 |
| ST-10 | Parse capability flags with a missing or non-boolean field | Contract failure; only the five boolean flags are accepted | AR-4, AR-12 |

### Schema and policy state

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-11 | Apply all migrations to an empty database | `policy_state` exists with `id`, `version`, `updated_at`; exactly one row `(1, 1)`; checks reject a second row, `id != 1`, and `version <= 0` | AR-21 |
| ST-12 | Regenerate database types | `PolicyState` row type and CType constants include `policy_state`; no diff after regeneration | AR-21 |
| ST-13 | Read the policy version | Returns the current positive bigint from the single row | AR-3, AR-21 |
| ST-14 | Create one assignment, then attempt a duplicate | Version increases by exactly one on success; the duplicate returns 409 and leaves the version unchanged | AR-6, AR-21 |
| ST-15 | Delete the `policy_state` row, then read the version through the repository | `PolicyUnavailableError`; no authorization decision is returned | AR-21, AR-27 |

### Policy evaluator

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-16 | Active user with no assignments evaluates any action | Deny `no_assignment`; no exception | RD-06 Must Have; AR-19 |
| ST-17 | Org-scoped role evaluates a project, secret, certificate, and service identity | Allow when the role contains the action; the same decision covers every project | RD-06 Technical Requirements §Evaluation |
| ST-18 | Project-scoped role evaluates its project and an object in that project | Allow; a resource in another project denies `scope_mismatch` | RD-06 Acceptance 3 |
| ST-19 | Object-scoped `secrets.reader` evaluates its secret, another secret, a project list, and a certificate | Allow only the exact secret; deny the other three | RD-06 Must Have; Acceptance 3 |
| ST-20 | Object-scoped reader evaluates a project-level action | Deny; object scope never covers a project or list | RD-06 Technical Requirements §Evaluation |
| ST-21 | Disabled principal with an otherwise valid org assignment | Deny `inactive_principal` | RD-06 Technical Requirements §Evaluation |
| ST-22 | Principal whose only matching assignment expired one second ago | Deny `expired_assignment`; an assignment expiring in the future allows | RD-06 Must Have; AR-14 |
| ST-23 | Service principal with a forged org-scoped `org.admin` row evaluates a control-plane action | Deny `service_control_plane` even though the row exists | RD-06 Must Have; Acceptance 4 |
| ST-24 | Project-scoped `org.admin` row evaluates an org-only action in that project | Deny; the ineligible scope row is ignored | RD-06 Scope eligibility; RD-05 bridge oracle |
| ST-25 | `project.admin` assigned at object scope; `reader` assigned at org scope | Object-scoped admin is not eligible and grants nothing; org-scoped reader grants `project.read`, `secret.list`, `certificate.list` only | RD-06 Scope eligibility |
| ST-26 | `identity.read` on a human principal with no owner project | Only an org-scoped assignment allows; a project assignment denies | RD-06 Identity ownership |
| ST-27 | Any allowed or denied decision | Includes `policyVersion`, actor kind, action, resource, and the matched assignment (or null) | AR-3, AR-25 |
| ST-28 | `capabilitiesFor` on a secret and a certificate for each role | The five flags equal the evaluator results for the mapped actions, including `canManage = assignment.write` | RD-06 Acceptance 9; AR-12 |
| ST-29 | `capabilitiesFor` called five times | Zero audit events; the enforcing controller records the action it checks | AR-10 |
| ST-30 | `authorize` called once; a denial repeated three times; then the audit port throws | Exactly one decision event per call; denial events carry an incrementing per-principal count; the count map stays bounded; on audit failure the call rejects with a policy-unavailable error and returns no allow | RD-06 Acceptance 8; AR-9, AR-19 |

### Assignments and grant guards

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-31 | Org admin grants org, project, and object assignments | 201 with id, tuple, grantor, creation time, expiry; version +1 per grant; one `assignment.grant` event per success | RD-06 Acceptance 1; AR-6, AR-20 |
| ST-32 | Project-scoped project admin grants in its project and in another project | Own project 201; other project 403 `access_denied`; no row in the other project | RD-06 Acceptance 5 |
| ST-33 | Project-scoped project admin grants `auditor`; org-scoped project admin grants `auditor` | Project-scoped → 403 (`audit.read` not held); org-scoped → 201 | RD-06 Acceptance 5; AR-12 |
| ST-34 | Auditor attempts to grant any role or revoke an assignment | 403 `access_denied`; auditor can still read assignments and explain | RD-06 Must Have; Acceptance 5 |
| ST-35 | Project admin and non-admin attempt to grant `org.admin` | Only an org-scoped org admin succeeds; all others 403 | RD-06 Must Have; Acceptance 5 |
| ST-36 | `secrets.manager` grants `project.admin`; `project.admin` grants `secrets.reader`; `project.admin` grants `auditor`; org-scoped `project.admin` grants `org.admin` | Manager → 403 (`grant_scope_not_covered`); project admin → 201; auditor grant → 403 (`grant_role_not_subset`); org-admin grant → 403 (`grant_org_admin_forbidden`) | RD-06 Must Have §Grant guards |
| ST-37 | Create an object assignment with `secrets.officer` or a project assignment with an unknown scope | 422 `validation_error`; scope eligibility is enforced | RD-06 Must Have; AR-6 |
| ST-38 | Grant a control-plane role to a service identity; grant `secrets.reader` at object scope to a service identity | Control-plane → 422 `service_control_plane`; object reader → 201 | RD-06 Acceptance 4 |
| ST-39 | Create the same tuple twice | First 201; second 409 `assignment_conflict`; one row; version unchanged by the failed attempt | RD-06 Acceptance 1; AR-6 |
| ST-40 | Delete the only org.admin assignment; then add a second and delete one | Sole delete → 409 `last_org_admin`; with two admins → 204 and one remains | RD-06 Acceptance 6 |
| ST-41 | Two concurrent deletes of two different org.admin assignments | Exactly one 204 and one 409; one active org admin remains; version increases once | RD-06 Acceptance 6; AR-18 |
| ST-42 | Delete an assignment id outside the caller's project | 404 `assignment_not_found`; the row and version are unchanged; the denial is audited | AR-16 |
| ST-43 | Project-scoped auditor lists assignments with each filter | Only assignments in its project/objects; filters are conjunctive; newest first; no foreign org rows | AR-15 |
| ST-44 | Principal with no `assignment.read` lists assignments | 403 `access_denied`, not an empty list | RD-06 Acceptance 2 |
| ST-45 | Send 31 assignment writes or 61 assignment reads in one minute from one principal | The extra request returns 429 `RATE_LIMIT_EXCEEDED`; another principal is unaffected | AR-8 |

### Access explain

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-46 | Project-scoped auditor explains its project and another project | Own project 200; another project 404 `resource_not_found`; no cross-project data | AR-5, AR-13 |
| ST-47 | Explain a project where an org admin, project admin, and reader can read | One entry per granting principal/assignment; a principal with no grant is absent | RD-06 Must Have; Acceptance 10 |
| ST-48 | Explain a resource consumed by a service identity | Entry includes the consumer compose project, service, hostname, state, and last-seen time; a user entry has `consumer: null` | RD-06 Must Have; AR-25 |
| ST-49 | Explain every role/scope combination for a fixed resource | The listed principals exactly equal the evaluator's allows; the policy version and scope match | RD-06 Acceptance 10 |
| ST-50 | Explain a missing object; then a soft-deleted secret; then a soft-deleted certificate | 404 `resource_not_found` in all three cases | AR-13 |
| ST-51 | Explain an unknown action, an unrecognized object type, or an object action with org scope | 422 `validation_error` | AR-5, AR-27 |
| ST-52 | Explain without a session | 401 `authentication_required` before any policy read | RD-06 Acceptance 2 |

### Identity bridge and regression

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-53 | Run the existing identity authorization cases through the bridge | Org roles cover every project; project roles cover only theirs; auditors are read-only; project-scoped org.admin is ignored; expired assignments and service principals are ignored | RD-06 Must Have; RD-05 bridge oracle |
| ST-54 | List identities as a user with no assignment | 403 `access_denied` instead of an empty array | RD-06 Acceptance 2 |
| ST-55 | Create/read/revoke an identity through the existing routes | Behavior is unchanged; each `can` decision emits one policy decision event | RD-06 Acceptance 8; AR-22 |
| ST-56 | Run the existing identity admin and agent integration suites | No expectation changes; all pass | RD-06 plan-local criterion 2 |

### Release verification

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-57 | Build the documentation site and check the new examples | Build passes; request/response examples match the strict contracts; no planning identifiers | Plan-local criterion 3 |
| ST-58 | Run `changeset status` | Lists `@openvault/api-contract` and `@openvault/server` at `minor` | Plan-local criterion 6 |
| ST-59 | PostgreSQL 16: apply migrations, run integration, run `db:types:check` | All pass; generated files unchanged | RD-06 plan-local criterion 4 |
| ST-60 | PostgreSQL 17: apply migrations, run integration, run `db:types:check` | All pass; generated files unchanged | RD-06 plan-local criterion 4 |

## Test Categories

### Specification Tests

| Test File | ST Cases Covered | Component |
|---|---|---|
| `packages/api-contract/tests/rbac.spec.test.ts` | ST-5–ST-10 | Contracts |
| `apps/server/tests/integration/rbac-catalog.spec.test.ts` | ST-1–ST-3 | Catalog constants |
| `apps/server/tests/integration/rbac-schema.spec.test.ts` | ST-11–ST-13, ST-15 | Schema and version |
| `apps/server/tests/integration/rbac-policy.spec.test.ts` | ST-4, ST-16–ST-30 | Catalog route, evaluator, and audit |
| `apps/server/tests/integration/rbac-assignments.spec.test.ts` | ST-14, ST-31–ST-45 | Assignment API and version |
| `apps/server/tests/integration/rbac-explain.spec.test.ts` | ST-46–ST-52 | Access explain |
| `apps/server/tests/integration/rbac-identity.spec.test.ts` | ST-53–ST-56 | Identity bridge |
| `apps/server/tests/integration/rbac-release.spec.test.ts` | ST-57, ST-58 | Docs and changeset |

### Implementation Tests

| Test File | Description | Priority |
|---|---|---|
| `apps/server/tests/integration/rbac-policy.impl.test.ts` | Scope matching edges, reason selection, version consistency, list visibility, capability mapping | High |
| `apps/server/tests/integration/rbac-assignments.impl.test.ts` | Transaction rollback, duplicate handling, orphan object cleanup, last-admin count, audit rollback | High |
| `apps/server/tests/integration/rbac-audit.impl.test.ts` | Logger field set, redaction, failure propagation, one event per decision | High |
| `packages/api-contract/tests/rbac.impl.test.ts` | Cross-field boundaries, ULID edges, strict unknown fields | Medium |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Assignment lifecycle over HTTPS | Auth plugin, controllers, policy, PostgreSQL | Create/list/delete with real sessions or CLI bearer tokens |
| Explain over HTTPS | Auth, policy, repository, consumers | Cross-project hiding and consumer projection |
| Identity admin regression | Identity service, bridge, policy, PostgreSQL | RD-05 routes through the new evaluator |
| Concurrent last-admin deletes | Two database sessions | Lock serialization and final invariant |

### End-to-End Tests

**N/A** — RD-06 has no CLI or web UI. The HTTP integration tests exercise the complete server
boundary. RD-11 and RD-12 own client end-to-end coverage.

## Test Data

### Fixtures Needed

- `seedRbacBase`: two projects, an org admin, a project admin, an org-scoped auditor, a
  project-scoped auditor, a reader, a service identity, a secret in each project, a certificate in
  each project, and a consumer row for the service identity.
- `RecordingPolicyAudit`: captures decision and mutation events for assertions.
- `FailingPolicyAudit`: throws on a chosen call to prove fail-closed behavior.
- `FakeClock`: controls expiry boundaries without sleeping.
- Reuse `testUlid`, `seedBase`, `createTestDatabase`, `applyMigrations`, and the HTTPS request
  helper.

### Mock Requirements

Only the audit-failure double and the clock. All authorization, persistence, migrations, HTTP,
and crypto-adjacent behavior uses real implementations.

## Verification Checklist

- [ ] All specification test cases (ST-*) are defined with concrete input/output pairs
- [ ] Every ST case traces to a requirement, spec document, or AR entry
- [ ] Specification tests are written before implementation
- [ ] Specification tests are verified to fail before implementation (red phase)
- [ ] All specification tests pass after implementation (green phase)
- [ ] Implementation tests cover edge cases and internals
- [ ] All unit and integration tests pass
- [ ] No regressions in the existing identity and agent suites
- [ ] `pnpm verify` passes under Node 24.21.0
- [ ] PostgreSQL 16 and 17 matrices pass
- [ ] `db:types:check` passes on both versions
- [ ] Documentation builds and the changeset is present
