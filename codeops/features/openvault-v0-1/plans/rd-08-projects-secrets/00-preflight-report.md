# Preflight Report: RD-08 Projects and Secrets

> **Document**: 00-preflight-report.md
> **Parent**: [Index](00-index.md)
> **Audit target**: all plan documents in `codeops/features/openvault-v0-1/plans/rd-08-projects-secrets/`
> **Context**: RD-06, RD-07, RD-10, RD-12, RD-13, the repository schema/crypto/policy/audit/transport code
> **Iterations**: 2
> **Status**: ✅ PREFLIGHT PASSED — all 51 findings resolved, 1 accepted consequence

> **⚠️ SAME-SESSION REVIEW:** The plan and this report were produced in the same session. Independent
> phase reviews (correctness and security/concurrency) run again during execution. This report
> records the planning-stage preflight only.

## Codebase Context Summary

| Area | Verified fact |
|---|---|
| Schema | `projects`, `secrets`, `secret_versions`, `consumers`, and `idempotency_keys` already exist; no migration is needed (`apps/server/src/database/schema.ts:46-57,235-247,296-339,461-472`). |
| Triggers | Version immutability, purge role/GUC/retention/protection, and protection-disable rejection exist (`apps/server/migrations/20261030094213_triggers-and-seed.up.sql:37-140`). |
| Crypto | AES-256-GCM envelope with a KEK; the wrap AAD omits project and object type; base64 decoding is lenient (`packages/core/src/crypto.ts:53-70,79-166`). |
| Keyring | `KeyringProvider` is not a core `Keyring`; it exposes `currentId` and the key callbacks (`apps/server/src/security/keyring.ts:99-158`). |
| Policy | The evaluator, list visibility, capabilities, and role matrix exist (`apps/server/src/rbac/policy-service.ts`, `roles.ts`). |
| Audit | The chain writer, persistent policy adapter, and request context exist (`apps/server/src/audit/`). |
| Transport | The global body limit is 128 KiB; the legacy `/v1/secrets` special case is 65,536 (`apps/server/src/transport/pre-stack.ts:22-23,138-176`). |
| Tests | Vitest unit, contract, and integration suites exist; the integration config runs files serially. |

## Iteration 1 Findings and Resolutions

| PF | Severity | Problem | Resolution | Status |
|---|---|---|---|---|
| PF-S01 | CRITICAL | Name-addressed lifecycle was ambiguous when deleted names were reused | AR-19/29: names are reserved until purge; per-name advisory lock; lifecycle resolves including deleted | Resolved |
| PF-S02 | MAJOR | Purge allow could survive a failed delete, contradicting the plan's own criterion | AR-17/32: one outcome event per attempt; purge writes allow or error after the destructive step; AC 5 narrowed to value writes | Resolved |
| PF-S03 | MAJOR | State-change audit mode was inconsistent; possible duplicate allow events | AR-17: authorize with audit disabled, then one joined allow on success or one independent error on failure; all flows updated | Resolved |
| PF-S04 | MAJOR | Project-create decision was org-scoped with no project object identity | Create authorizes on the generated project resource; ST-18 asserts the identity | Resolved |
| PF-S05 | MAJOR | 403 vs 404 cross-project behavior was contradictory | AR-3/27 + 03-01 taxonomy: `scope_mismatch`/`expired_assignment` → 404; `no_assignment` → 403; tests added | Resolved |
| PF-S06 | MAJOR | No deleted-secret-by-name lookup | `findSecretByName` including deleted plus name reservation | Resolved |
| PF-S07 | MAJOR | Protection could be enabled on a deleted secret through no reachable route | Protection is active-only; the claim was removed | Resolved |
| PF-S08 | MAJOR | Config allowed a value larger than the database cap | AR-25: config max 65,536; 413 before insert; ST-29 | Resolved |
| PF-S09 | MAJOR | Crypto expected a core `Keyring`, but production has `KeyringProvider` | `EnvelopeKeyring` port implemented by both; ST-17 | Resolved |
| PF-S10 | MAJOR | Active-only version count left total growth unbounded | AR-12: count all retained versions; ST-73/74 | Resolved |
| PF-S11 | MAJOR | `latest` did not fall back to the newest active version | AR-8: newest active version; 410 only when none; ST-66/67 | Resolved |
| PF-S12 | MAJOR | Access-explain and object assignment creation bypassed project deletion | AR-27: `findObject` and `listExplainCandidates` require active parents; ST-23 | Resolved |
| PF-S13 | MINOR | Future expiry was not enforced | Service validation; ST-45 | Resolved |
| PF-S14 | MINOR | Protection test did not delete/age before purge | ST-61 updated | Resolved |
| PF-S15 | MAJOR | Phase 1 gate depended on Phase 2 secret routes | Phase/test mapping updated | Resolved |
| PF-S16 | MAJOR | Secret contract tests were written after the contracts | ST-4..9 moved to Phase 1.1 before 1.2.2 | Resolved |
| PF-S17 | MINOR | Task counts were wrong | Header/phase table/success criterion now 65 tasks (19/18/15/13) | Resolved |
| PF-S18 | MINOR | Phase sets omitted modified files | Phase sets and Related Files updated | Resolved |
| PF-S19 | MINOR | Combined tag filter could not represent a maximum pair | Split into `tagKey`/`tagValue` | Resolved |
| PF-S20 | MINOR | Duplicate capability schema; subresource capability claim | Reuse `capabilityFlagsSchema`; capabilities only on metadata/value | Resolved |
| PF-S21 | MINOR | "Active consumer" undefined | AR-15: active principal, any `secret.read` role, all consumer states | Resolved |
| PF-S22 | MINOR | Mixed clocks for retention | AR-13 + 03-04: database clock for stored timestamps | Resolved |
| PF-S23 | MINOR | Dangling object-scope assignments after purge | AR-3: missing objects are inert and hidden by the visibility queries | Resolved |
| PF-S24 | MINOR | Envelope validation was incomplete | AR-7 + 03-01: strict base64, exact keys, lengths, ULID AAD, ciphertext limit | Resolved |
| PF-S25 | MINOR | Missing version-limit, secrets.reader, and leakage tests | ST-73/74/80/87/90 | Resolved |
| PF-S26 | MINOR | Test matrix assigned server tests to the contract package | Test matrix corrected; HTTP spec file added | Resolved |
| PF-S27 | MINOR | Cursor validation undefined | AR-10: base64url `{name,id}`, malformed → 422 | Resolved |
| PF-S28 | MINOR | Valid escaped 64 KiB values exceeded the 128 KiB transport limit | AR-25: 524,288 `/v1/data` guard; ST-30 | Resolved |
| PF-S29 | MINOR | Purger membership in a superuser role could bypass ownership checks | AR-28: reject superuser/owner membership on every call | Resolved |
| PF-G01 | HIGH | Deleted-secret lifecycle lookup missing | Same as PF-S01/S06 | Resolved |
| PF-G02 | HIGH | Keyring type mismatch | Same as PF-S09 | Resolved |
| PF-G03 | HIGH | Envelope validation absent | Same as PF-S24 | Resolved |
| PF-G04 | MEDIUM | Wrap AAD omitted project | AAD v2 includes project in both domains | Resolved |
| PF-G05 | MEDIUM | Idempotency replay could not load the original version | `findVersionById`; all claim columns updated; explicit `version` in write responses | Resolved |
| PF-G06 | MEDIUM | Three different value-size limits | AR-25 aligns config, database, and transport | Resolved |
| PF-G07 | MEDIUM | Cross-project status mapping | Same as PF-S05 | Resolved |
| PF-G08 | MEDIUM | Purge pool could target another database | `current_database()` check on every purge | Resolved |
| PF-G09 | MEDIUM | Phase sets omitted files | Updated | Resolved |
| PF-G10 | LOW | Task totals wrong | Updated to 65 | Resolved |
| PF-G11 | LOW | Crypto architecture docs/sidebar not updated | Phase 4 tasks added | Resolved |
| PF-G12 | LOW | Contract suite assigned DB tests | Test matrix corrected | Resolved |
| PF-G13 | LOW | Tag filter bound off by one | `tagKey`/`tagValue` replace the combined bound | Resolved |
| PF-G14 | LOW | `false` protection behavior contradictory | False/false no-op; true→false 409 | Resolved |
| PF-G15 | LOW | Stale citations | Refreshed to symbols/current ranges | Resolved |
| PF-R01 | MAJOR | Project delete vs secret write TOCTOU | Project `FOR SHARE` inside the data transaction; delete serializes | Resolved |
| PF-R02 | MAJOR | Audit chain/data row lock-order deadlock | AR-26: chain lock first; `AuditWriter.lockChain`; deadlock test added | Resolved |
| PF-R03 | MAJOR | Value leakage not fully tested | ST-87 scans responses, headers, audit, and logs | Resolved |
| PF-R04 | MAJOR | No read-audit-failure test | ST-72 forces a read writer failure | Resolved |
| PF-R05 | MAJOR | Failed reads could leave only an allow event | AR-32: one outcome event; ST-67 | Resolved |
| PF-R06 | MAJOR | Purge contradicted the plan's "no allow after rollback" criterion | AC 5 narrowed; purge writes one outcome after the destructive step | Resolved |
| PF-R07 | MAJOR | Deleted-secret lookup missing | Same as PF-S01/S06 | Resolved |
| PF-R08 | MINOR | Protection-on-deleted unreachable | Removed; active-only | Resolved |
| PF-R09 | MAJOR | Cross-project visibility mapping and unaudited missing 404 | Mapping added; missing names are documented as unaudited 404 because no target exists | Resolved |
| PF-R10 | MINOR | Recovery name conflict race | Name reservation + advisory lock; conflict cannot occur for a new active row | Resolved |
| PF-R11 | MAJOR | State transitions did not recheck after locking | Conditional `UPDATE ... RETURNING`; service maps no-row | Resolved |
| PF-R12 | MAJOR | Config value cap exceeded DB cap | Same as PF-S08 | Resolved |
| PF-R13 | MINOR | AAD fields unvalidated | Same as PF-S24 | Resolved |
| PF-R14 | MINOR | 64 KiB tests did not prove the boundary | ST-28 read-back, ST-29 over-limit, ST-30 escape-heavy, ST-32/33/34 base64 | Resolved |
| PF-R15 | MINOR | Missing version-limit/expiry-write tests | ST-69/73/74 | Resolved |
| PF-R16 | MINOR | Capability tests could not prove one snapshot | ST-80 role coverage; ST-81 snapshot-count test seam | Resolved |
| PF-R17 | MAJOR | Only successful purge test could be skipped | CI must run it; helper returns undefined only for non-superuser local runs; ST-64/65 | Resolved |
| PF-R18 | MAJOR | Retention/expiry clocks not deterministic | Database clock for storage; service clock for audit; row updates in tests | Resolved |
| PF-R19 | MINOR | Replay after intervening writes was ambiguous | `version` in write response; replay returns current metadata + written version; ST-50 | Resolved |
| PF-R20 | MINOR | Rollback tests did not assert audit absence | ST-70/71 assert no allow | Resolved |
| PF-R21 | MINOR | `displayName` was product-scope creep | Removed from the API and plan | Resolved |
| PF-R22 | MINOR | Agent route/CLI docs crossed RD boundaries | RD-10 explicitly assigns the agent handler; CLI docs task removed | Resolved |
| PF-R23 | MINOR | Object-scope list behavior undefined | `secret.list` is project/org scope; object reader gets 403; ST-41 | Resolved |
| PF-R24 | MINOR | Tag grammar/cursor gaps | `tagKey`/`tagValue`; malformed cursor 422 | Resolved |
| PF-R25 | MINOR | Limiter key missed agents; placement | `req.agent?.principalId ?? req.auth?.user.id`; mounted on `/v1/data` after auth | Resolved |
| PF-R26 | MAJOR | Project-create event lacked project identity | Same as PF-S04 | Resolved |

## Iteration 2 Findings and Resolutions

| PF | Severity | Problem | Resolution | Status |
|---|---|---|---|---|
| PF-S201 | MAJOR | Read returned 410 before authorization | Authorize before version selection; one error event when no version is active | Resolved |
| PF-S202 | MAJOR | Create checked names before authorization | Authorize before any name check; ST-91 | Resolved |
| PF-S203 | MAJOR | Allow + error produced two events per attempt | AR-32: exactly one outcome event per attempt | Resolved |
| PF-S204 | MAJOR | Project-create failure event could violate the audit project FK | Failure uses system scope with `projectId:null` and the generated object id | Resolved |
| PF-S205 | MAJOR | Replay was gated by lifecycle prechecks | Claim before lifecycle checks; ST-92 | Resolved |
| PF-S206 | MAJOR | V2 AAD empty-table precondition was not executable | Release task 4.1.8 and the secrets guide require both version tables empty before first boot; the repository is pre-release with no version rows | Resolved |
| PF-S207 | MINOR | Validator rejected an authenticated empty ciphertext | Crypto allows zero-length ciphertext; the API rejects empty values | Resolved |
| PF-S208 | MINOR | Versions/consumers lacked the denial mapping | Same mapping applied; ST-40/90 | Resolved |
| PF-S209 | MINOR | Recovery took a caller-supplied `updatedAt` | Removed; database `now()` is the only clock | Resolved |
| PF-S210 | MINOR | Invalid purge URL would fail boot but claimed 503 | Parse lazily; invalid config leaves the server bootable and purge returns 503 | Resolved |
| PF-S211 | MINOR | Purge did not take the name advisory lock | Purge takes the same `(project_id,name)` lock on the purger connection | Resolved |
| PF-S212 | MINOR | Replay metadata semantics were ambiguous | Replay returns current metadata plus the original written version | Resolved |
| PF-G201 | HIGH | Create replay hit the name conflict | Same as PF-S202/PF-S205 | Resolved |
| PF-G202 | HIGH | All-expired read bypassed authorization | Same as PF-S201 | Resolved |
| PF-G203 | HIGH | Empty ciphertext rejected by the validator | Same as PF-S207 | Resolved |
| PF-G204 | MEDIUM | JSON parser hard limit stayed 128 KiB | Parser limit raised to `1mb`; per-path guards applied; ST-30 | Resolved |
| PF-G205 | MEDIUM | Versions/consumers mapping inconsistent | Same as PF-S208 | Resolved |
| PF-G206 | MEDIUM | Purge did not serialize with project delete | Purger transaction locks the active project `FOR SHARE` | Resolved |
| PF-G207 | MEDIUM | Purge helper threw instead of allowing a skip | Helper returns `undefined` for non-superuser local runs; CI runs the success case | Resolved |
| PF-G208 | LOW | "Forged" cursor claim was impossible without signing | ST-47 now covers malformed cursors only | Resolved |
| PF-R201 | CRITICAL | Create checked names before authorization and idempotency | Same as PF-S202/PF-S205 | Resolved |
| PF-R202 | MAJOR | One-way protection permanently reserved a name | Accepted consequence of AR-13/19, documented and tested in ST-88 | Accepted |
| PF-R203 | MAJOR | Active-only version limit left growth unbounded | AR-12 counts all retained rows; ST-73/74 | Resolved |
| PF-R204 | MAJOR | Purge project check was outside the destructive transaction | Same as PF-G206 | Resolved |
| PF-R205 | MAJOR | KEK was reused directly as an HMAC key | AR-30: HKDF-SHA256 subkey `openvault:idempotency:v1` | Resolved |
| PF-R206 | MAJOR | Agent fetch did not update `last_seen` | Agent value read calls `touchConsumer`; ST-89 | Resolved |
| PF-R207 | MAJOR | Audit events lacked the version id | Secret read/write events include `details.version`; implementation task updated | Resolved |
| PF-R208 | MAJOR | No deadlock regression test | Integration test "Concurrent rename vs decision" | Resolved |
| PF-R209 | MAJOR | Project-delete hiding not spec-tested for secrets/identities/certificates | ST-90 | Resolved |
| PF-R210 | MINOR | Purge URL parse timing | Same as PF-S210 | Resolved |
| PF-R211 | MINOR | Empty ciphertext | Same as PF-S207 | Resolved |
| PF-R212 | MINOR | Keyring outage mapping | `KeyringError` maps to 503; `destroyed` getter defined | Resolved |
| PF-R213 | MINOR | Query control characters | `q` rejects control characters; cursor is base64url | Resolved |
| PF-R214 | MINOR | Recovery 409 paths had no outcome event | Recovery writes one error outcome on failure | Resolved |
| PF-R215 | MINOR | Assignment create status on a hidden object | Hidden/deleted object returns 404 `resource_not_found` | Resolved |
| PF-R216 | MINOR | Task count mismatch | Updated to 65 tasks (19/18/15/13) | Resolved |
| PF-R217 | MINOR | Stale index text/files | Index overview, decisions, and Related Files refreshed | Resolved |
| PF-R218 | MINOR | Purge test helper throw/skip mismatch | Same as PF-G207 | Resolved |
| PF-R219 | MINOR | Snapshot-count test instrumentation | Test seam `loggerDestination`/policy counter documented in 07 | Resolved |
| PF-R220 | MINOR | Base64 boundary bytes not tested | ST-32/33/34 cover empty, whitespace, invalid, and binary boundaries | Resolved |
| PF-R221 | MINOR | Limiter unauthenticated bucket | Limiter is mounted after auth; key falls back to the authenticated principal; anonymous requests fail auth | Resolved |

## Verdict

- **CRITICAL:** 0 open.
- **MAJOR:** 0 open. PF-R202 is an explicitly documented consequence of one-way purge
  protection: a protected deleted secret's name is reserved forever. This is accepted in
  AR-13/19 and tested by ST-88.
- **MINOR:** 0 open. Every minor was resolved or folded into a resolved behavior.
- **Pass tier:** ✅ PREFLIGHT PASSED — all 51 findings resolved, 1 accepted consequence.

## Residual Risks

| Risk | Owner | Revisit |
|---|---|---|
| The v2 AAD change is one-way. A deployment with existing v1 version rows would need a migration. | RD-14 release gate | Before the first production release or when RD-09/RD-10 write version rows |
| A crash between the destructive purge and its outcome event leaves the deletion without evidence. | RD-13 operations | If audit completeness for purge becomes a hard requirement |
| Expired idempotency rows are not cleaned by a scheduler. | RD-13 operations | When table growth becomes material |
| A protected deleted secret permanently reserves its name. | Product owner | If a rename/trash feature is requested |
