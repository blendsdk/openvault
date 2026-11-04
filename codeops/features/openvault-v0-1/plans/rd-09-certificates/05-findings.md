# Findings Ledger: RD-09 Certificates

> **Document**: 05-findings.md
> **Parent**: [Index](00-index.md)

Post-phase correctness and security/concurrency reviews ran on the complete RD-09 diff.
All critical and major findings were fixed; no critical or major finding remains open.

| Finding | Severity | Area | Ruling |
|---|---|---|---|
| RC-901 | MAJOR | certificates/pem | Fixed — post-parse X.509 validation errors map to 422 |
| RC-902 | MAJOR | certificates/pem | Fixed — key DER buffers are zeroed on every parse/validation failure |
| RC-903 | MINOR | certificates/pem | Fixed — email canonicalization, 320 bound, domain labels, case-insensitive dedupe |
| RC-904 | MINOR | certificates/service | Fixed — cursor/chain/private-key work precedes allow events; error outcomes added |
| RC-905 | MINOR | certificates/service | Fixed — parse/generate failures write one error outcome |
| RC-906 | MINOR | certificates/expiry | Mitigated — eligibility is rechecked after the claim; the remaining send-window race is documented |
| RC-907 | MINOR | certificates/expiry | Fixed — allow/error dedupe and audit id persistence |
| RC-908 | MINOR | config/loader | Fixed — 2,048 bound and IPv6 link-local/mapped targets rejected |
| RC-909 | MINOR | certificates/lifecycle | Fixed — purge state compares database time |
| RC-910 | MINOR | docs | Fixed — audit and zeroing wording corrected |
| RC-911 | MINOR | tests | Partially fixed — rate limits, key-profile rejection, no-key audit, project normalization, superseded-version cleanup, and non-current expiry tests added; remaining gaps are listed below |
| SA-901 | MAJOR | certificates/expiry | Fixed — keyset batches of 500 bound the scan |
| SA-902 | MINOR | certificates/generate | Fixed — SAN count/text and generated PEM bounds |
| SA-903 | MINOR | certificates/expiry | Fixed — superseded-version notification rows are removed on renewal |
| SA-904 | MINOR | certificates/pem | Fixed — same as RC-902 |
| SA-905 | MINOR | certificates/service | Fixed — read gate precedes project resolution and maps to the data-plane 404 |
| SA-906 | MINOR | certificates/service | Fixed — same as RC-904 |
| SA-907 | MINOR | config/loader | Fixed — same as RC-908 |

## Accepted Residuals

| Item | Rationale | Owner / revisit |
|---|---|---|
| Expiry warning after the eligibility recheck | A delete or renewal can commit between the recheck and the webhook; the receiver may get one extra warning with a stable `eventId`. New scans exclude the resource. | RD-13 operations / revisit if exactly-once delivery is required |
| Expiry at-least-once delivery | A crash after send but before mark-sent can duplicate a warning; the payload carries a stable `eventId` for receiver dedupe. | RD-13 operations |
| Expiry retry cadence | A stale pending claim is reclaimed on a later run, normally the next daily run; the one-hour lease is a concurrency guard, not a timer. | RD-13 operations |
| Protected deleted names | One-way protection reserves the name permanently; recover before retention or use a new name. | Product owner |
| Purge evidence window | The destructive purge uses a separate dedicated session; a crash between delete and outcome leaves the deletion without evidence. | RD-13 operations |
| Certificate write idempotency | No `Idempotency-Key`; `expectedVersionId` is the stale-write guard. | RD-11 CLI |
| Private-key PEM string | The DER buffer is zeroed on every path; the transient PEM string cannot be zeroed. | RD-13 security review |
| DNS rebinding | The webhook URL is operator-controlled and never logged; DNS can rebind after validation. | RD-13 operations |
| Agent value-read success over real mTLS | Certificate routes are denied on the agent listener; a no-certificate 401 test exists, but the valid same-project agent 401 and project-mismatch 403 matrix is not exhaustively exercised over HTTPS. | RD-10 |
| Write-route project existence | Read routes normalize missing/inaccessible projects; write/lifecycle routes can still distinguish a missing project from a denied one. No certificate data is exposed. | RD-12 review |
| Certificate version history surface | No versions-list route or consumers in v0.1; a client uses `?version=` when it knows the id. | Product owner |

## Re-review

The correctness and security reviewers' findings were fixed in one pass. The full
`pnpm verify`, `db:migrate` + `db:types:check`, changeset status, docs build, and the
PostgreSQL 16/17 integration suites (660/660 each) pass after the fix.
