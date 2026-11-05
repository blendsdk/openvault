# Preflight Report: RD-10 Agent Delivery and Compose

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Audit target**: all plan documents in `codeops/features/openvault-v0-1/plans/rd-10-agent-compose/`
> **Context**: RD-05, RD-07, RD-08, RD-09, RD-10, RD-11, the current agent server subsystem, the data-plane secret route, RBAC, contracts, transport, tests, and deployment docs
> **Iterations**: 3 (design challenge + correctness + security/concurrency review, a plan revision, and a focused re-review)
> **Status**: ✅ PREFLIGHT PASSED — every actionable critical/major finding resolved; one requirement-inherent wrapper trust residual accepted and documented

> **⚠️ SAME-SESSION REVIEW:** The plan and this report were produced in the same session. Independent
> correctness and security/concurrency reviews run again during execution. This report records the
> planning-stage preflight only.

## Codebase Context Summary

| Area | Verified fact |
|---|---|
| Agent server | Join, renewal, authentication, revocation, consumer upsert, and the default-deny listener already exist (`apps/server/src/agent/*`). |
| Data route | `GET /v1/data/:project/secrets/:name` is served on the agent listener; the service touches `last_seen` after a successful decrypt (`apps/server/src/controllers/secrets.ts:151-160`, `apps/server/src/secrets/service.ts:621-627`). |
| Consumer state | `consumers.state` already allows `ok`, `degraded`, and `failed`; the heartbeat does not update it (`apps/server/src/database/schema.ts:245`, `apps/server/src/secrets/repository.ts:748-753`). |
| Consumer audit | Join and renewal classify `state` as a metadata change and write `consumer.update`; a `last_seen`-only update is not audited (`apps/server/src/agent/consumer-repository.ts:185-187`). |
| Identity services | Project, identity, assignment, and join-token services already expose the scaffold operations (`apps/server/src/projects/service.ts`, `apps/server/src/identity/identity-service.ts`, `apps/server/src/rbac/assignment-service.ts`). |
| Project names | The active-name unique index is partial; a soft-deleted project name can be reused (`apps/server/migrations/20261030094203_initial.up.sql:371`). |
| Service names | The active service-name unique index is partial; a disabled name can be reused (`apps/server/migrations/20261103141309_service-identities.up.sql:32`). |
| Contracts | `identityNameSchema` allows Unicode and punctuation, so it is not safe as a Compose key or host path (`packages/api-contract/src/identities.ts:16-21`). |
| Agent listener scope | The scope middleware runs first and returns 404 for non-agent paths (`apps/server/src/transport/scope.ts:86-99`). |
| Renewal replay | The five-minute replay cache is process-local; after a server restart the old certificate gets `409 renewal_not_current` (`apps/server/src/agent/agent-renew-service.ts:20-22,299-307`). |
| Existing test harness | Real CA/CSR/client fixtures and a real mTLS listener exist (`apps/server/tests/integration/helpers/agent-tls.ts`, `apps/server/tests/integration/helpers/agent-app.ts`). |

## Design Challenger Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| DC-01 | Critical | The non-root agent cannot write Docker-created root-owned bind/volume directories, and the app fragment omits the same UID. | The scaffold now uses per-service bind mounts with `create_host_path: false`, an exact `install -d -m 0700 -o 10001 -g 10001` preparation comment, app `user: "10001:10001"`, and a `/run/openvault` tmpfs owned by 10001 (AR-21, ST-89/92). |
| DC-02 | Critical | Fixed `openvault-agent`/state-volume names collide for two services in one Compose project. | The renderer derives `openvault-agent-<slug>`, `./openvault-state/<slug>`, and `openvault.<slug>.manifest.yaml`; each app depends on its own agent (AR-21, ST-91). |
| DC-03 | Critical | Optional-entry degradation makes the Compose healthcheck fail, so the app never starts. | Added `ov-agent health --ready`, which exits 0 when all required entries are delivered even if optional entries are degraded. The Compose healthcheck uses it; plain `health` keeps 0/1/2 (AR-13, ST-72/73). |
| DC-04 | Major | Wrapper mode leaks the join token and other `OPENVAULT_*` variables into the child. | The child environment removes every `OPENVAULT_*` and `COMPOSE_PROJECT_NAME` variable and adds only manifest `env:` entries (AR-15, ST-79). |
| DC-05 | Major | A new project with non-empty entries is infeasible because it has no secrets. | The scaffold now returns 422 without creating a project when entries are present and the project is absent. A new project with empty entries creates the project/identity/token and a manifest skeleton (AR-19/20, ST-97/98). |
| DC-06 | Major | The claimed soft-deleted-project 409 is unreachable. | The plan now accepts the existing behavior: a soft-deleted project name is reused as a new active project; old hidden rows stay hidden (AR-22, ST-102). |
| DC-07 | Major | A policy 403 on the secret read does not update consumer state. | The controller maps agent 403 to `failed` (and 404/410 to degraded/failed by optionality) and writes the heartbeat best-effort (AR-18, ST-50). |
| DC-08 | Major | The final aggregate state is not recorded when the last entry fails. | Added `POST /v1/agent/consumer` and a final heartbeat after every startup/refresh cycle (AR-18, ST-53). |
| DC-09 | Major | Consumer state changes bypass the audit chain. | Added `AgentConsumerService`; a state change writes one `consumer.update` event, a `last_seen`-only update does not (AR-18, ST-53/54/55). |
| DC-10 | Major | Server-certificate trust failures purge files like a client credential rejection. | The plan follows RD-10's explicit rule: every TLS certificate rejection is a fail-closed credential failure with table-driven tests. This is recorded as the intended behavior, not silently relaxed (AR-17, ST-69). |
| DC-11 | Major | A lost renewal response after a server restart becomes `409 renewal_not_current`, which the plan treated as generic terminal. | Added explicit `renewal_not_current` handling: adopt a newer on-disk identity, otherwise stop renewal and keep delivering until expiry (AR-10, ST-64/65). |
| DC-12 | Major | Both `file:` and `env:` are allowed but the delivery model stores one target. | `DeliveredEntry` now holds a target array; both are delivered in wrapper mode (AR-3/15, ST-6/44). |
| DC-13 | Major | Removing a manifest entry leaves its old file readable. | Added `managed-files.json` and startup reconciliation (AR-8/28, ST-24/45). |
| DC-14 | Major | The service name is interpolated into YAML and a host path without a Compose-safe schema. | Added `composeServiceNameSchema` and quoted YAML scalars; traversal and metacharacter tests are mandatory (AR-21, ST-105/106). |
| DC-15 | Major | The app fragment omits the required UID and token-placement comment. | Added both; ST-89/90 assert them (AR-21). |
| DC-16 | Major | An expired stored certificate is reused instead of requiring a rejoin. | State loading validates the certificate dates; expired/not-yet-valid state is treated as absent (AR-9, ST-17). |
| DC-17 | Major | Acceptance 9 (cross-project tmpfs isolation) has no test. | Added renderer invariants ST-116/117 and a documented manual host check (AR-21/24). |
| DC-18 | Major | The Phase 1 red phase cannot run because the package does not exist. | Task 1.1.1 creates the package skeleton before the spec tests; task 1.1.4 records the red phase (99). |
| DC-19 | Major | Duplicate scaffold entries produce an invalid manifest. | The request schema refines uniqueness; ST-99 covers it (AR-19). |
| DC-20 | Minor | Task counts were inconsistent. | The plan now has 79 tasks with phase counts 16/12/13/20/18. |

## Correctness Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| CR-01 | Critical | `identityNameSchema` permits path/YAML injection in the scaffold service name. | Fixed by the Compose slug and quoting (AR-21, ST-105). |
| CR-02 | Major | Scaffold response used `Date`-bearing service records without projection. | Added explicit `toScaffoldResponse` projection and contract tests (AR-19, ST-87/108/109). |
| CR-03 | Major | Soft-deleted project 409 was unreachable. | Behavior changed to reuse; AR-22/ST-102. |
| CR-04 | Major | An existing expired object assignment was treated as a successful live grant. | The service deletes and recreates expired assignments (AR-22, ST-95). |
| CR-05 | Major | Startup wrote files one by one, so a later write could leave a mixed set. | Startup stages all files and removes the managed set on failure (AR-12, ST-29). |
| CR-06 | Major | Refresh reset the aggregate to `ok`; a last-entry failure was never recorded. | Refresh starts from the previous state and sends a final heartbeat (AR-18/31, ST-53). |
| CR-07 | Major | A secret-level 403 does not update consumer state. | Controller 403 mapping (AR-18, ST-50). |
| CR-08 | Major | 409 `renewal_not_due`/`renewal_not_current` were not distinguishable in the client model. | Added explicit error kinds and renewal handling (AR-10/17, ST-63/64/65). |
| CR-09 | Major | Fixed agent/volume names collide. | Per-service names (AR-21, ST-91). |
| CR-10 | Major | Non-root directory ownership fails on first start. | Host preparation command, `create_host_path: false`, app UID (AR-21, ST-89/92). |
| CR-11 | Major | The scaffold controller lacked the standard error mapping. | Added `execute`/`mapError` and ST-108 (AR-19). |
| CR-12 | Major | The wrapper child inherits the join token. | Sanitized child environment (AR-15, ST-79). |
| CR-13 | Major | The scaffold route on the agent listener returns 404, not 401. | ST-107 and the spec now expect 404 from the scope guard. |
| CR-14 | Major | Coverage claims missed acceptance 9, acceptance 14, and service-name injection. | Added ST-105/106/116/117. |
| CR-15 | Major | Phase 1 spec tests ran before the package existed. | Skeleton task moved first (99). |
| CR-16 | Major | Index linked to missing preflight/findings artifacts. | This report and `05-findings.md` now exist. |
| CR-17 | Minor | Duplicate scaffold entries. | Uniqueness refinement (AR-19, ST-99). |
| CR-18 | Minor | Both file/env was unrepresentable. | Target array (AR-3/15, ST-6/44). |
| CR-19 | Minor | Rename-then-chmod could replace the old target before a failure. | `fchmod` before `rename`; post-rename failure semantics are explicit (AR-6, ST-40). |
| CR-20 | Minor | Renewal transient state was not represented in status. | Added a renewal state to the status document (AR-13, ST-70). |
| CR-21 | Minor | The token-placement comment was missing. | Added and tested (AR-21, ST-90). |
| CR-22 | Minor | Task counts were wrong. | Corrected to 79 (16/12/13/20/18). |
| CR-23 | Minor | The quick-reference assignment shape was inconsistent. | Aligned to `{name, assignment}`. |
| CR-24 | Minor | The controller had no defined route to the heartbeat service. | Added `AgentConsumerService` and registration (AR-18). |
| CR-25 | Minor | A denied scaffold pre-check was not audited. | The service records the denial before returning 403 (AR-19). |
| CR-26 | Minor | Agent renewal replay was not linked to the server row-count test. | ST-60 now requires both the CSR reuse and one `workload_certs` row; the existing server test is referenced. |
| CR-27 | Minor | Several code citations were off by a few lines. | Corrected in `02-current-state.md` and the register. |

## Security and Concurrency Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| SC-01 | Critical | Wrapper child runs as the same UID and can read the agent state/private key. | Requirement-inherent: RD-10 mandates same-UID wrapper mode and env export. The plan sanitizes the child environment, documents wrapper mode as fully trusted, keeps sidecar as the secure default, and records the residual in `docs/security/limitations.md` (AR-32). No same-UID OS isolation is possible without dropping privileges, which RD-10 does not define. |
| SC-02 | Major | Fixed Compose names share state between services. | Per-service names and paths (AR-21, ST-91). |
| SC-03 | Major | Unsafe service names escape the tmpfs root or inject YAML. | Compose slug + quoting + tests (AR-21, ST-105/106). |
| SC-04 | Major | Docker-created mounts are root-owned and not writable by 10001. | Host preparation command, `create_host_path: false`, app UID (AR-21, ST-89/92). |
| SC-05 | Major | The wrapper child inherits the join token and `OPENVAULT_*`. | Sanitized child environment (AR-15, ST-79). |
| SC-06 | Major | `renewal_not_current` after a lost response/server restart was terminal. | Graceful reload/stop-renewal handling (AR-10, ST-64/65). |
| SC-07 | Major | Overlapping refreshes can re-add files after a credential failure. | Single-flight, cancellation flag, and pre-write checks (AR-31, ST-42/43). |
| SC-08 | Major | Removed manifest entries remain readable. | Managed-file reconciliation (AR-8/28, ST-24/45). |
| SC-09 | Major | Aggregate consumer state can stay `ok` under a persistent failure. | Final heartbeat route and previous-state carry-over (AR-18, ST-53). |
| SC-10 | Major | Reused identity may already have project/org-wide reader or manager grants. | Broader-grant detection returns 409 `identity_scope_conflict` (AR-22, ST-94). |
| SC-11 | Major | TLS error lists were incomplete. | Family/prefix classification with unknown TLS errors failing closed (AR-17, ST-69). |
| SC-12 | Major | A 90-day certificate overflows `setTimeout`. | Chunked 24-hour timers and `renewal_not_due` rescheduling (AR-10, ST-59/63). |
| SC-13 | Minor | Soft-deleted project names were said to return 409. | Reuse behavior documented (AR-22, ST-102). |
| SC-14 | Minor | Duplicate scaffold entries. | Uniqueness refinement (AR-19, ST-99). |
| SC-15 | Minor | `chmod` after `rename` could leave a `0600` file on failure. | `fchmod` before `rename` (AR-6, ST-40). |
| SC-16 | Minor | Response bodies were unbounded and successful bodies were not schema-validated. | 1 MiB bound and shared schema parsing (AR-17, ST-38). |
| SC-17 | Minor | Health could report stale `ok`. | `--max-age` staleness check (AR-13, ST-71/73). |
| SC-18 | Minor | Re-scaffold left older unused tokens valid. | `rotateJoinToken` before issuing a new token (AR-19, ST-88). |
| SC-19 | Minor | The agent-listener scaffold path returns 404, not 401. | ST-107 corrected. |
| SC-20 | Minor | The socket parent `0700` makes `0660` group access unusable. | Documented as same-UID access; the app runs as the same UID (AR-13/14, AR-21). |
| SC-21 | Minor | Consumer `composeProject`/`composeService` accept control characters in the shared contract. | The agent validates both as safe Compose names; tightening the RD-05 contract is out of this plan's modification set and is recorded as an upstream residual for RD-05/RD-14. |
| SC-22 | Minor | State read had a TOCTOU window. | `O_NOFOLLOW` + `fstat` from the open descriptor (AR-8, ST-21). |
| SC-23 | Minor | The scaffold route had no rate limiter. | Added a 5/minute per-principal limiter (AR-19, 4.2.9). |
| SC-24 | Minor | Wrapper child can rewrite the status file. | Same-UID trust residual; documented with the wrapper limitation (AR-32). |

## Second Focused Re-Review

The revised plan was re-reviewed by a correctness lens and a security/concurrency lens. The
second pass confirmed the task arithmetic (79 = 16/12/13/20/18) and found eight further
major issues, all resolved in the current text:

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| RR-M01 | Major | A project-scoped actor cannot see an org-scope assignment through `AssignmentService.list`, so broader-grant rejection is bypassed. | Added `PolicyRepository.listAllLiveForPrincipal`, authorized by the scaffold's project `assignment.write` check, and ST-94 covers an org-scope grant seen by a project admin (AR-22). |
| RR-M02 | Major | Terminal startup/refresh paths exit before the final heartbeat, leaving consumer state `ok`. | Added the shared terminal handler that sends a best-effort `failed` heartbeat when mTLS still works; ST-27/38/53 cover it (AR-18). |
| RR-M03 | Major | Phase 1/2 gates included tests for behavior implemented later. | Moved ST-24 to Phase 2, ST-71–ST-73 to Phase 3, and signal-shutdown tests to Phase 3; the phase references and test-file table are aligned. |
| RR-M04 | Major | The heartbeat route returns 204 but the client treats 204 as terminal. | The route now returns 200 `{state}` and the client validates `agentConsumerStateResponseSchema` (AR-18, ST-53/109). |
| RR-M05 | Major | Re-scaffolding with fewer entries leaves old object-scope grants. | The scaffold lists and deletes object-scope `secrets.reader` assignments not in the requested set (AR-19, ST-93). |
| RR-M06 | Major | `identity_scope_conflict` was not in an existing error union, so it would surface as 500. | Added `ScaffoldServiceError` and controller mapping (AR-19, ST-108). |
| RR-M07 | Major | Renewal credential failure did not set the shared cancellation flag, so a refresh could re-add files. | Renewal and refresh now share the terminal handler and mutation queue (AR-31, ST-68b). |
| RR-M08 | Major | The managed ledger reconciled entry names, not file targets, and startup optional failures could leave stale optional files. | The ledger stores output root, manifest hash, and exact file targets; validation and file-to-env/rename cleanup are specified (AR-8/28, ST-24/28/44). |
| RR-m01 | Minor | The heartbeat route awaited a service that could throw on audit failure. | `AgentConsumerService.update` catches and logs audit failure; the response succeeds (AR-18, ST-55). |
| RR-m02 | Minor | The index still excluded a heartbeat route and the quick-reference shape was stale. | Excluded machinery and quick reference corrected. |
| RR-m03 | Minor | ST-57 said 404/401 for the admin heartbeat. | Now expects 404 only. |
| RR-m04 | Minor | The consumer-state test file name was inconsistent. | Standardized on `secrets-consumer-state.spec.test.ts`. |
| RR-m05 | Minor | ST-60 mixed agent CSR reuse with a server row-count assertion. | Split into the agent test and the existing server replay test. |
| RR-m06 | Minor | Health could not compute staleness from the status file. | Added `refreshMs`/`staleAfterMs` to the status document (AR-13, ST-71/73). |
| RR-m07 | Minor | Renewal terminal/not-found responses had no defined outcome. | Added `agent_renewal_terminal` and ST-68a (AR-10). |
| RR-f01 | Minor | Token revoke and issue were separate transactions. | Added atomic `AgentTokenService.rotate` / `IdentityService.rotateJoinToken` (AR-19, ST-88). |
| RR-f02 | Minor | The managed ledger could name a path outside the output root or apply to a new root. | Ledger validation, output-root binding, and a 100-entry cap (AR-8/28, ST-24). |
| RR-f03 | Minor | Renewal reset a degraded consumer state to `ok`. | Renewal preserves the existing state (AR-18, ST-56). |
| RR-f04 | Minor | The transient socket list was incomplete. | The full `E*` network family is transient (AR-17, ST-69). |
| RR-f05 | Minor | The CA/manifest bind files were not prepared for UID 10001. | Added `install -m 0444` to the preparation comment (AR-21, ST-92). |
| RR-f06 | Minor | The state directory mode was not checked exactly. | Exact `0700` required (AR-8, ST-20). |
| RR-f07 | Minor | `renewal_not_current` did not check `identityId`. | Adoption requires the same identity id (AR-10, ST-64/65). |
| RR-f08 | Minor | YAML mapping keys could parse as non-strings. | Every mapping key goes through `yamlQuote` (AR-21, ST-106). |
| RR-f09 | Minor | The state/manifest paths were not Compose-project scoped. | Paths now include `${COMPOSE_PROJECT_NAME}` (AR-21, ST-116). |

## Accepted Residuals

These are recorded in `docs/security/limitations.md` during Phase 5:

1. **Wrapper same-UID trust.** A wrapped application runs as the same UID and can read the
   agent state directory, private key, and status file. Wrapper mode is opt-in and requires a
   fully trusted application; sidecar mode is the secure default. Removing wrapper mode would
   violate RD-10; dropping child privileges would require a different file-mode and group model
   that RD-10 does not define (AR-32).
2. **Expired-certificate heartbeat gap.** An expired client certificate is rejected by the
   middleware before a principal is available, so the consumer state cannot be updated on that
   request. Revocation sets `failed`; expiry is expected to be avoided by two-thirds renewal.
3. **Network-failure state lag.** A network failure cannot reach the server. The next successful
   fetch or heartbeat corrects the consumer state.
4. **Non-durable renewal replay.** The server's five-minute replay cache is process-local. A
   server restart or a retry after five minutes can require a new join token; the agent keeps
   delivering with the old certificate until expiry.
5. **Consumer metadata character set.** The shared RD-05 contract still accepts 1–100 arbitrary
   characters for Compose project/service. The agent validates safe values; a direct malicious
   join could store control characters. This is an upstream contract residual for RD-05/RD-14.
6. **No published agent image.** RD-10 delivers the binary and scaffold; RD-14 owns image build,
   UID contract, signing, and publishing.

## Plan Readiness Proof

| Check | Result |
|---|---|
| Required plan documents exist | ✅ `00`, `01`, `02`, `03-01`, `03-02`, `03-03`, `07`, `99` |
| `00-index.md` declares the implemented RD | ✅ `> **Implements**: openvault-v0-1/RD-10` |
| Ambiguity register has no open material item | ✅ 32/32 resolved |
| Specification tests precede implementation | ✅ Every feature phase has spec tests, a distinct red task, implementation, green task, impl tests, and a gate |
| Critical/major preflight findings resolved | ✅ All actionable findings resolved; one requirement-inherent wrapper residual accepted and documented |
| Task counts consistent | ✅ 79 tasks: 16/12/13/20/18 |
| Verification command confirmed | ✅ `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, docs build, PostgreSQL 16/17 integration |

## Verdict

**PASS for execution.** The plan is grounded in the existing server contracts, adds no migration,
and has a spec-first execution path with phase-correct test placement. The only accepted
critical-adjacent residual is wrapper-mode same-UID trust, which is inherent to RD-10's explicit
wrapper requirement and is documented as a secure-default trade-off rather than an implementation
defect.
