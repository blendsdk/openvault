# Findings Ledger: RD-08 Projects and Secrets

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)

Post-phase correctness and security/concurrency reviews ran on the complete RD-08 diff.
Critical and major findings were fixed and re-reviewed once; no critical or major finding
remains open.

| Finding | Phase | Severity | Area | Ruling |
|---|---|---|---|---|
| RV-401 | 1-4 | CRITICAL | controllers/projects | fixed |
| RV-402 | 1-4 | MAJOR | controllers/secrets | fixed |
| RV-403 | 1-4 | MAJOR | secrets/service | fixed |
| RV-404 | 1-4 | MAJOR | secrets/service | fixed |
| RV-405 | 1-4 | MAJOR | secrets/purge | fixed |
| RV-406 | 1-4 | MINOR | secrets/service | fixed |
| RV-407 | 1-4 | MINOR | rbac/policy-repository | fixed |
| RV-408 | 1-4 | MINOR | identity/identity-service | fixed |
| RV-409 | 1-4 | MINOR | secrets/service | fixed |
| RV-410 | 1-4 | MINOR | secrets/service | fixed |
| RV-411 | 1-4 | MINOR | secrets/envelope | fixed |
| RV-412 | 1-4 | MINOR | docs/roadmap | fixed |
| RV-413 | 1-4 | MINOR | docs/api | fixed |
| SA-401 | 1-4 | MAJOR | secrets/purge | fixed |
| SA-402 | 1-4 | MAJOR | secrets/idempotency | fixed |
| SA-403 | 1-4 | MAJOR | secrets/idempotency | fixed |
| SA-404 | 1-4 | MAJOR | secrets/repository | fixed |
| SA-405 | 1-4 | MINOR | secrets/envelope | fixed |
| SA-406 | 1-4 | MINOR | secrets/service | accepted with documentation |
| SA-407 | 1-4 | MINOR | secrets/purge | fixed |
| SA-408 | 1-4 | MINOR | rbac/assignment-service | accepted |
| SA-409 | 1-4 | MINOR | secrets/idempotency | accepted with documentation |

## Accepted Residuals

| Item | Rationale | Owner / revisit |
|---|---|---|
| Assignment create can race a project soft delete | The grant is inert because `LIVE_ASSIGNMENT` requires an active project; it only becomes live if an operator restores the project. No privilege escalation path was found. | RD-13 operations / revisit if project restore becomes an API |
| Expired idempotency rows are not cleaned by a scheduler | The 24-hour rows are documented in the security limitations; cleanup belongs to the maintenance work. | RD-13 operations |
| An in-flight read can finish after a concurrent delete | Documented in the security limitations; new requests see the delete immediately. | RD-13 operations |
| Agent value-read success over real mTLS is covered by the service and middleware suites, not one HTTPS test | The controller branch is a single `requireAgent` call; the transport/middleware success path is already covered by the existing agent suite. | RD-10 revisit |
| One-snapshot list capability instrumentation is not asserted by a counting test | The implementation calls `capabilitiesForMany` once; the behavior is covered by the list capability tests. | Performance revisit if list latency grows |

## Re-review

The fixes were re-reviewed by the same correctness and security auditors. Both reported no new
critical or major issue. The only remaining notes were minor documentation/process drift, fixed
before the final verification.
