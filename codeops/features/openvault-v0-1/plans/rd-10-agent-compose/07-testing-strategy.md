# Testing Strategy: RD-10 Agent Delivery and Compose

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage Goals

| Code type | Target |
|---|---|
| Manifest, configuration, state, failure matrix | 95% |
| HTTPS client, join, renewal | 90% |
| Status, socket, wrapper, CLI | 90% |
| Scaffold service and renderer | 90% |
| Server consumer-state extension | 90% |

- Test names state behavior: `should [expected behavior] when [condition]`.
- Agent tests use real Node crypto, `@peculiar/x509`, real filesystem directories, and a real
  HTTPS fake vault. Server tests use real PostgreSQL 16/17 and the real agent listener.
- No Docker, external vault, or mocked TLS is required. Docker Compose E2E is `N/A` because
  RD-10 does not publish an image (AR-27); renderer invariants and the real listener integration
  cover the same boundaries. A documented manual check covers host/container isolation.

## 🚨 Specification Test Cases (MANDATORY — NON-NEGOTIABLE)

> These cases derive from `RD-10-agent-compose.md`, the plan specs, and the Ambiguity Register.
> They are the immutable oracle. If the implementation differs, the implementation is wrong.
> In-code traceability comments restate the behavior in plain language, never an ST/RD id.

### Configuration and Manifest

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | Valid manifest with project, service, refresh, output_dir, and two entries | Parses; `refreshMs=300000`; hash is `sha256:` plus 64 hex; entries retain order and default mode `0400` | RD-10 manifest, AR-5 |
| ST-2 | Manifest with an unknown top-level or entry field | Startup fails `agent_manifest_invalid` before any network request | RD-10 acceptance 1, AR-5 |
| ST-3 | `file: ../escape`, `/abs`, `a/b`, `.`, `..` | Each fails `agent_manifest_invalid`; no file is written | RD-10 acceptance 1, AR-6 |
| ST-4 | Two entries with the same `file`, `env`, or `name` | Fails `agent_manifest_invalid` | AR-5 |
| ST-5 | Entry with neither `file` nor `env` | Fails `agent_manifest_invalid` | RD-10 manifest rule, AR-5 |
| ST-6 | Wrapper entry with both `file: db_password` and `env: DB_PASSWORD` | Accepted; the file is written and the env value is exported | RD-10 "at least one", AR-3, AR-15 |
| ST-7 | Sidecar entry with `env:` | Fails `agent_manifest_invalid` | RD-10 manifest rule, AR-3 |
| ST-8 | `mode: "0777"`, `"0644"`, `"0401"`, or mode on an env-only entry | Fails `agent_manifest_invalid` | AR-6 |
| ST-9 | Manifest project, service, or output_dir differs from the environment | Fails `agent_manifest_invalid`; no network request | RD-10 manifest scope, AR-4 |
| ST-10 | `refresh: 29s`, `86401s`, `abc`, or a negative value | Fails; `30s` and `86400s` succeed | AR-5 |
| ST-11 | `OPENVAULT_URL` is HTTP, has a path, credentials, query, or fragment | Fails `agent_config_invalid` | AR-4, AR-17 |
| ST-12 | Missing `OPENVAULT_CA_FILE`, `OPENVAULT_PROJECT`, `OPENVAULT_SERVICE`, or `COMPOSE_PROJECT_NAME` | Fails `agent_config_invalid` before reading the manifest | AR-4 |
| ST-13 | Missing manifest, file over 1 MiB, duplicate YAML keys, or an unsafe `COMPOSE_PROJECT_NAME` | Fails `agent_manifest_invalid` / `agent_config_invalid` | AR-5 |

### State and Join

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-14 | First start with a valid token and no state | Generates an EC P-256 key and CSR; the join body contains token, CSR, and consumer metadata only; no private key field | RD-10 acceptance 2, AR-9 |
| ST-15 | Successful join | State directory `0700`; `identity.json` is regular, owned by the test UID, mode `0600`; certificate and key round-trip | RD-10 acceptance 2, AR-8 |
| ST-16 | Existing valid unexpired state and no join token | Uses the existing certificate; no join request | AR-9 |
| ST-17 | Stored certificate is expired or not yet valid | Treated as absent; a join token is required; with a token, a new key/CSR joins | AR-9 |
| ST-18 | Join returns 401/403 or a TLS certificate rejection | Fails `agent_join_failed`; no state file is written | RD-10 failure matrix, AR-9 |
| ST-19 | Join has two transient network failures then succeeds | Retries the same token, key, and CSR; one join is recorded | AR-9 |
| ST-20 | State file is a symlink, owned by another UID, mode `0644`, or a directory | Fails `agent_state_insecure`; does not overwrite or silently rejoin | AR-8 |
| ST-21 | State file is swapped between `lstat` and read | `O_NOFOLLOW`/`fstat` detects the swap and fails closed | AR-8 |
| ST-22 | Two starts race to create the state directory | One creates `0700`; the other accepts the secure directory; no world-readable window | AR-8 |
| ST-23 | Pending-renewal file is younger/older than five minutes | Younger is reused; older is replaced with a new key/CSR | AR-10 |
| ST-24 | `managed-files.json` names a file no longer targeted, has a different output root, or contains `../escape` | Only valid names under the recorded root are removed; a mismatched ledger is ignored; unrelated files are untouched | AR-8, AR-28 |

### Startup and Delivery

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-25 | Startup with all required entries available | Writes each file atomically with mode `0400` by default; status `ok`; heartbeat sent | RD-10 acceptance 4, AR-6 |
| ST-26 | Startup with one required 404 | Writes no managed file; status `failed`; exits non-zero | RD-10 acceptance 3, AR-12 |
| ST-27 | Startup with one required 500 or network error | Writes no managed file; status `failed`; best-effort `failed` heartbeat; exits non-zero | RD-10 acceptance 3, AR-12, AR-18 |
| ST-28 | Startup with an optional 404 or transient failure | Writes required files; removes any previous optional file; status `degraded`; `requiredReady` true | RD-10 Should Have, AR-12, AR-13 |
| ST-29 | A startup write fails after the fetch | No partial target; the managed set is removed; status `failed`; exit 1 | AR-12 |
| ST-30 | Kill between temporary write and rename | The final path is absent or the previous complete value; no partial target exists | RD-10 acceptance 4, AR-6 |
| ST-31 | Refresh after a 5xx for a required entry | Previous file remains; status `degraded`; process continues | RD-10 acceptance 5, AR-11 |
| ST-32 | Refresh after a 5xx for an optional entry | Previous optional file remains; status `degraded`; process continues | RD-10 optional rule, AR-11 |
| ST-33 | Refresh after 401 or 403 | Every managed file is removed; status `failed`; exit 1 | RD-10 acceptance 6, AR-11 |
| ST-34 | Refresh after a TLS certificate rejection | Same credential-failure path as ST-33 | RD-10 acceptance 6, AR-17 |
| ST-35 | Refresh after a required 404 or 410 | Every managed file is removed; status `failed`; exit 1 | RD-10 failure matrix, AR-11 |
| ST-36 | Refresh after an optional 404 or 410 | Removes only that file; status `degraded`; process continues | RD-10 failure matrix, AR-11 |
| ST-37 | Refresh after another 4xx (400/409/422) | Removes all managed files; status `failed`; exit 1 | AR-11 |
| ST-38 | Refresh after 3xx, 204, 1xx, malformed 200, or a body over 1 MiB | Removes all managed files; sends a best-effort `failed` heartbeat; status `failed`; exit 1 | AR-11, AR-17, AR-18 |
| ST-39 | Refresh after 429 | Keeps last-known-good; status `degraded`; retries next interval | AR-11 |
| ST-40 | File write fails after a successful fetch | Previous file remains or the new complete file is present; status `failed`; exit 1; no partial file | AR-6 |
| ST-41 | Output directory is created | Mode `0700`, owned by the current UID; an insecure existing directory fails closed | RD-10 output rule, AR-6 |
| ST-42 | A refresh tick fires while a slow refresh is active | The tick is skipped; no overlapping cycle or stale overwrite | AR-31 |
| ST-43 | A credential failure races an in-flight refresh | Cancellation prevents any later write or re-add; the managed set stays removed | AR-31 |
| ST-44 | A manifest entry has both file and env targets; another changes from file to env or renames its file | Both targets are delivered; the old file target is removed on restart | AR-3, AR-15, AR-28 |
| ST-45 | A refresh removes an optional entry | Its previous file is removed; required files stay | AR-11, AR-28 |

### Consumer State

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-46 | Agent fetch sends `X-OpenVault-Consumer-State: ok` and a 200 is returned | `last_seen` moves and `state` is `ok` | RD-10 acceptance 8, AR-18 |
| ST-47 | Agent fetch sends `degraded` and a 200 is returned | `state` becomes `degraded`; one consumer row remains | AR-18 |
| ST-48 | Optional entry 404 with `X-OpenVault-Entry-Optional: true` | `state` becomes `degraded` even though the response is 404 | AR-18 |
| ST-49 | Required entry 404 with `X-OpenVault-Entry-Optional: false` | `state` becomes `failed` | AR-18 |
| ST-50 | Policy denies a secret read with 403 | `state` becomes `failed`; the agent takes the credential path | AR-18 |
| ST-51 | Invalid, duplicate, or array-valued state/optional header on the agent listener | 422 `validation_error`; no read, audit, or heartbeat | AR-18 |
| ST-52 | A user/browser request sends the same headers | Headers are ignored; no consumer state changes | AR-18 |
| ST-53 | Final `POST /v1/agent/consumer {state:"degraded"}` after a last-entry 5xx | 200 `{state:"degraded"}`; `state` becomes `degraded`; one `consumer.update` event with `changed:["state"]` | AR-18 |
| ST-54 | Heartbeat with an unchanged state | `last_seen` moves; no new audit event | AR-18 |
| ST-55 | Heartbeat state change while audit is unavailable | The state update rolls back; the response still succeeds; the next heartbeat retries | AR-18 |
| ST-56 | Repeated fetches | The consumer row count stays one per identity; metadata is not duplicated | RD-10 acceptance 8 |
| ST-57 | Heartbeat on the admin listener | 404 `not_found` from the scope guard; no consumer update | AR-18 |

### Renewal

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-58 | Certificate lifetime is 30 days | First renewal attempt is at two-thirds of the actual window plus jitter, before expiry | RD-10 renewal rule, AR-10 |
| ST-59 | Certificate lifetime is 90 days | The timer is chunked; no immediate overflow retry loop | AR-10 |
| ST-60 | Renewal response is lost on the first attempt | Retry reuses the same pending key and CSR; the server sees one public key and one row | RD-10 acceptance 13, AR-10 |
| ST-61 | Renewal succeeds | State is replaced atomically; the pending file is removed; the next renewal uses the new dates | AR-10 |
| ST-62 | Renewal keeps failing for more than five minutes | A new key/CSR is generated after the window | AR-10 |
| ST-63 | Renewal returns 409 `renewal_not_due` | Rescheduled at the computed threshold; files and certificate remain | AR-10 |
| ST-64 | Renewal returns 409 `renewal_not_current` with no newer on-disk identity | Renewal stops; delivery continues until expiry; files remain; status `degraded` | AR-10 |
| ST-65 | Renewal returns 409 `renewal_not_current` with a newer on-disk identity | The newer identity is adopted; delivery continues | AR-10 |
| ST-66 | Renewal returns 401/403 or TLS certificate rejection | Files removed; status `failed`; exit 1 | RD-10 failure matrix, AR-10 |
| ST-67 | Renewal transient 5xx/network | Old certificate and files remain; retry continues | AR-10 |
| ST-68 | Renewed certificate/key mismatch or corrupt state | Fails closed; does not continue with an unusable identity | AR-8 |
| ST-68a | Renewal returns 404, 3xx, 204, or a malformed/oversized body | Removes all managed files; status `failed`; exit 1 | AR-10, AR-17 |
| ST-68b | Renewal credential failure during an active refresh | Cancellation drains the write queue; no file is re-added after removal | AR-31 |
| ST-69 | Table-driven TLS certificate rejection codes | Every `ERR_TLS_*`, `ERR_SSL_*`, `CERT_*`, `UNABLE_TO_*`, self-signed, and hostname code takes the credential path | AR-17 |

### Status, Socket, Wrapper, and Logging

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-70 | Status after success/degraded/failed | Correct state, `requiredReady`, manifest hash, last times, renewal state, and entry states; no value/PEM/token keys | RD-10 status rule, AR-13 |
| ST-71 | `ov-agent health` reads ok/degraded/failed/missing/stale using `staleAfterMs` | Exit 0/1/2/2/2; prints only the state | RD-10 health rule, AR-13 |
| ST-72 | `ov-agent health --ready` with optional degraded but all required ready | Exit 0; Compose can start the application | AR-13 |
| ST-73 | `ov-agent health --ready` with a required failure or stale file | Exit 2 | AR-13 |
| ST-74 | Local socket `GET /v1/secrets/<manifest entry>` | Returns the last delivered value, encoding, version, and time | RD-10 acceptance 7, AR-14 |
| ST-75 | Local socket `GET /v1/secrets/<unknown>` | 404; no vault request | RD-10 acceptance 7, AR-14 |
| ST-76 | Local socket `GET /v1/status` | Status document; no values; no vault request | AR-14 |
| ST-77 | Socket file mode | `0660`; parent `0700`; stale socket replaced, a regular file is not | AR-14 |
| ST-78 | Wrapper mode with a file and an env entry | File is written; only the env entry is exported; no other secret is visible | RD-10 wrapper rule, AR-15 |
| ST-79 | Wrapper child environment contains sentinel `OPENVAULT_JOIN_TOKEN` and `OPENVAULT_*` | The child environment contains none of them; only manifest `env:` values are added | AR-15 |
| ST-80 | Sidecar mode with an env entry | Startup fails `agent_manifest_invalid` | AR-3 |
| ST-81 | Wrapper child exits 7 | Agent exits 7 after stopping timers/socket | AR-3 |
| ST-82 | Wrapper credential failure while the child runs | Files removed; child terminated; agent exits 1 | RD-10 failure matrix, AR-15 |
| ST-83 | `--once` in ok/degraded/failed | Exits 0/1/2 after one fetch and heartbeat; no socket or timers | AR-3 |
| ST-84 | Captured logs across success, 5xx, 401, TLS failure, join, renewal, corrupt state, and malformed response | No sentinel value, private key, PEM body, join token, file content, or raw parser body appears | RD-10 acceptance 12, AR-16 |
| ST-85 | Wrapper env contains a denied loader name | Startup fails `agent_manifest_invalid` | AR-15 |
| ST-86 | Binary base64 secret mapped to `env` | Per-entry failure; optional degrades, required fails; no invalid UTF-8 is exported | AR-15 |

### Scaffold

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-87 | Org admin scaffolds an existing project with two entries | Two `secrets.reader` object assignments exist; one token is returned; response contract parses | RD-10 acceptance 10, AR-19 |
| ST-88 | Re-run the same scaffold, including two concurrent runs | Same project/identity/active assignments; exactly one live unused token; no duplicates | AR-22 |
| ST-89 | Compose and manifest responses | Compose has per-service agent service, tmpfs mount, `vault_net`, healthcheck, app `user`, and `depends_on` on its own agent; manifest lists the entries | RD-10 Compose scaffold, AR-21 |
| ST-90 | Token absence | Neither `compose` nor `manifest` contains the literal token; compose contains `${OPENVAULT_JOIN_TOKEN}` and the "set the token outside this file" comment | RD-10 acceptance 10, AR-21 |
| ST-91 | Two scaffolds for two services in one Compose project | Distinct agent service names, state paths, manifest mounts, and app `depends_on` targets | RD-10 one agent per service, AR-21 |
| ST-92 | Compose host-path preparation | The snippet contains the exact `install -d -m 0700 -o 10001 -g 10001` command for both directories and `install -m 0444` for the CA/manifest files | AR-21, AR-27 |
| ST-93 | Authorization rows after scaffold; then scaffold again with a smaller entry set | Exactly object-scope `secrets.reader` for the current entries; removed-entry grants are deleted; no project/org reader | RD-10 acceptance 10, AR-19 |
| ST-94 | Reused identity already has a project/org reader or manager grant, including an org-scope grant invisible to a project-scoped actor | 409 `identity_scope_conflict`; no new token | AR-22 |
| ST-95 | Existing expired object-scope assignment | Deleted and recreated; one live assignment | AR-22 |
| ST-96 | Unknown secret name | 422 `validation_error` with the name; no identity, assignment, or token is created | AR-20 |
| ST-97 | New project with empty entries | Project, identity, token, and a manifest skeleton with a placeholder comment; no grants | AR-19, AR-20 |
| ST-98 | New project with entries | 422 without creating the project | AR-20 |
| ST-99 | Duplicate entry names | 422 before any grant or token | AR-19 |
| ST-100 | Project-scoped `project.admin` scaffolds an existing project | Succeeds; the identity is owned by that project | RD-10 role rules, AR-19 |
| ST-101 | Viewer/auditor without `assignment.write` | 403 `access_denied`; no project/identity/token is created | AR-19 |
| ST-102 | Soft-deleted project name | Reused as a new active project; old hidden rows stay hidden | AR-22 |
| ST-103 | Disabled identity with the same name | A new active identity is created; the disabled row is unchanged | AR-22 |
| ST-104 | Invalid body (bad names, >100, duplicate, unknown field) | 422 `validation_error` | AR-19 |
| ST-105 | Service names `..`, `/`, `:`, `#`, `${...}`, spaces, or uppercase | Rejected by `composeServiceNameSchema`; no path escape or YAML injection | AR-21 |
| ST-106 | Compose renderer for leading-digit, `on`, `yes`, and normal service names | Every mapping key and scalar is quoted; output parses with string keys; no docker socket mount | AR-21 |
| ST-107 | Scaffold route on the agent listener | 404 `not_found` from the scope guard; no scaffold data | AR-19 |
| ST-108 | Scaffold service/controller errors | 409/422/403/503 map to the documented stable codes, not 500 | AR-19 |

### Contract and Cross-Cutting Security

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-109 | `scaffoldRequestSchema`, `scaffoldResponseSchema`, and `agentConsumerStateResponseSchema` | Accept valid objects; reject unknown fields, duplicate entries, bad service slugs, and missing projections; heartbeat response is `{state}` | AR-18, AR-19 |
| ST-110 | `agentConsumerStateSchema` | Accepts only `ok`/`degraded`/`failed`; rejects unknown fields | AR-18 |
| ST-111 | Agent join/renew request bodies | No `privateKey` or `key` field; no PEM private-key label in the body | RD-10 acceptance 2, AR-9 |
| ST-112 | Status, local socket status, logs, errors, compose, and manifest | No secret value, private key, certificate body, or join token; the value endpoint is the only documented value surface | RD-10 acceptance 12, AR-13, AR-16 |
| ST-113 | Output path traversal through a manifest name | Rejected before any request; no file outside the output root | AR-6 |
| ST-114 | Consumer state header on a project-mismatched agent certificate | Existing 403 from the agent guard; no consumer update | RD-05, AR-18 |
| ST-115 | Scaffold creates only object-scope grants and the identity fetches a non-granted secret | 403 `access_denied`; no value returned | RD-10 least privilege, AR-19 |
| ST-116 | Two Compose projects' rendered paths | Distinct `/dev/shm/openvault/<project>/<service>`, state paths, and manifest mounts; no shared identity state | RD-10 acceptance 9, AR-21 |
| ST-117 | Rendered agent service | No `/var/run/docker.sock`, no privileged mode, no host network | RD-10 acceptance 14, AR-21 |

## Test Categories

### Specification Tests (from ST-cases above)

| Test File | ST Cases Covered | Component |
|---|---|---|
| `apps/agent/tests/manifest.spec.test.ts` | ST-1–ST-13 | Configuration and manifest |
| `apps/agent/tests/join.spec.test.ts` | ST-14–ST-23 | State and join |
| `apps/agent/tests/delivery.spec.test.ts` | ST-24–ST-45 | Startup and delivery |
| `apps/agent/tests/renewal.spec.test.ts` | ST-58–ST-69, ST-68a, ST-68b | Renewal |
| `apps/agent/tests/status-socket.spec.test.ts` | ST-70, ST-74–ST-77 | Status and socket |
| `apps/agent/tests/wrapper-logging.spec.test.ts` | ST-71–ST-73, ST-78–ST-86 | Health, wrapper, and logging |
| `apps/server/tests/integration/secrets-consumer-state.spec.test.ts` | ST-46–ST-57, ST-114 | Consumer state |
| `apps/server/tests/integration/scaffold.spec.test.ts` | ST-87–ST-108, ST-115–ST-117 | Scaffold |
| `packages/api-contract/tests/scaffold.spec.test.ts` | ST-109–ST-110 | Contracts |
| `apps/server/tests/integration/agent-logging.spec.test.ts` | ST-84, ST-112 | Agent listener logging (extend) |
| `apps/server/tests/integration/agent-renew.spec.test.ts` | ST-60 | Server replay row count (extend) |

### Implementation Tests (edge cases, internals)

| Test File | Description | Priority |
|---|---|---|
| `apps/agent/tests/atomic-write.impl.test.ts` | Temp cleanup, fsync/rename failure, staged startup, concurrent writers | High |
| `apps/agent/tests/client.impl.test.ts` | TLS classification table, timeout, redirect refusal, body bounds, schema parse | High |
| `apps/agent/tests/state.impl.test.ts` | Directory race, O_NOFOLLOW swap, pending age, managed-file reconciliation | High |
| `apps/agent/tests/runner.impl.test.ts` | Single-flight, cancellation, timer jitter, signal shutdown, child termination | High |
| `apps/server/tests/integration/scaffold.impl.test.ts` | Partial failure retry, expired assignment, disabled identity, broader grant, renderer determinism, two-service merge | High |
| `apps/server/tests/integration/secrets-state.impl.test.ts` | Heartbeat failure tolerance, state audit, audit rollback | Medium |
| `packages/api-contract/tests/scaffold.impl.test.ts` | Boundary and projection cases | Medium |

### Integration Tests

| Test | Components | Description |
|---|---|---|
| Agent + real TLS fake vault | Agent client, join, delivery, renewal | Real HTTPS, client certificate, CSR, file writes, failure matrix |
| Scaffold + real server | Controller, service, project/identity/assignment services, PostgreSQL | End-to-end create, reuse, token, grants, per-service compose |
| Consumer state + real agent listener | Agent middleware, controller, service, repository, audit | Real mTLS fetch updates `last_seen`/`state` and audits transitions |

### End-to-End Tests

| Scenario | Steps | Expected Result |
|---|---|---|
| First-run delivery | Fake vault join + two secret reads + heartbeat | State stored, two files written, status ok, socket serves both |
| Stale value survives transient failure | First refresh ok, second returns 500, heartbeat degraded | File unchanged, status degraded, server state degraded |
| Revocation fails closed | First refresh ok, next returns 403 | Files removed, status failed, exit 1 |
| Lost renewal response | Renewal response dropped, retry with same CSR | Same key/CSR, one certificate row, state updated |

Docker Compose E2E is `N/A`; RD-10 does not publish an image (AR-27). The renderer and real
listener integration cover the wiring; the manual host check is documented.

## Test Data

### Fixtures Needed

- A disposable EC P-256 CA, server certificate, and client certificate generated with
  `@peculiar/x509`.
- A fake vault that records requests and can return 200/401/403/404/410/409/429/5xx, drop the
  socket, use an untrusted CA, or return malformed/oversized bodies.
- Manifest files for valid, unknown-field, traversal, duplicate, mode, both-target, and
  mismatch cases.
- Temporary state, output, status, and socket directories under the test temp directory.
- Sentinel secret values, a sentinel join token, and a sentinel env value for leakage
  assertions.

### Mock Requirements

No core component is mocked. The fake vault is a real HTTPS server; the filesystem is real; the
CSR library is real; PostgreSQL is real. Only the clock and timer scheduling are injectable.

## Verification Checklist
- [ ] All specification test cases (ST-*) defined with concrete input/output pairs
- [ ] Every ST case traces to a requirement, spec doc, or AR entry
- [ ] Specification tests written BEFORE implementation
- [ ] Specification tests verified to FAIL before implementation (red phase)
- [ ] All specification tests pass after implementation (green phase)
- [ ] Implementation tests written for edge cases and internals
- [ ] All unit / integration tests pass
- [ ] No regressions in existing tests
- [ ] `pnpm verify`, `pnpm db:types:check`, `pnpm changeset status`, `pnpm audit:prod`, and the
      docs build pass
- [ ] Integration suite passes on PostgreSQL 16 and 17
