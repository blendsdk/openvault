# Ambiguity Register: Security Findings Wave 2

> **Status**: ✅ GATE PASSED — all 17 items resolved
> **Last Updated**: 2026-11-07 01:46

## Planning scope

| Boundary | Value |
|---|---|
| Planning target | Issues #46–#52: seven confirmed scanner findings at revision `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a` |
| Context artifacts | `report.md`, `threatmodel.md`, `docs/security/*`, `docs/reference/*`, affected server/CLI/web/Deploy modules and tests |
| Modification set | This plan folder; `apps/server`, `apps/cli`, `apps/web`, `deploy/postgres`, `deploy/compose`, security/reference docs |

## Register

| # | Category | Ambiguity / Gap | Options Presented | Decision | Status |
|---|----------|-----------------|-------------------|----------|--------|
| 1 | Scope ambiguities | Which findings are in scope? | A: all seven · B: only High | A — all seven issues #46–#52 | ✅ Resolved — user objective |
| 2 | Priorities & sequencing | What order? | A: severity order · B: by module | A — P0 #46, #47, #48, #50; P1 #49, #51, #52. Implementation order: #46, #48, #47, #50, #49, #51, #52 | ✅ Resolved — AI delegated by `--auto-design`: security-critical first, isolated changes before cross-cutting DB work |
| 3 | Technical unknowns | How should `ov doctor` bind credentials to an origin? | A: inline origin compare · B: shared helper · C: disable credential check on override | B — shared `requireSameOrigin` helper used by doctor and tests; keep TLS/readiness unauthenticated on mismatch | ✅ Resolved — AI delegated: reuse the existing origin-binding rule without duplicating it |
| 4 | Security & compliance | How should the pruner lose direct SQL authority? | A: constrained `SECURITY DEFINER` procedure + single-use authorization · B: accept pruner as break-glass admin | A — procedure consumes a short-lived authorization created after verify/export/checkpoint; pruner gets `EXECUTE` only | ✅ Resolved — user accepted the constrained-procedure recommendation |
| 5 | Behavioral gaps | What completion evidence does a prune need? | A: chained event only · B: receipt table + chained event | B — the procedure writes an immutable receipt atomically with the delete; the chained `audit.prune` event remains the human record | ✅ Resolved — AI delegated: a crash after delete must not lose completion evidence |
| 6 | Behavioral gaps | When should `SecretService.read` write the allow event? | A: before decrypt · B: after decrypt and encode | B — allow only after successful decrypt, encode, and capability lookup; every failure writes an error event | ✅ Resolved — AI delegated: match the certificate-private-read pattern |
| 7 | Security & compliance | How should the app role lose control-plane reads? | A: explicit per-table allowlist · B: column revokes only | A — revoke all app privileges, grant an explicit allowlist, remove default privileges, add a restricted consumer view | ✅ Resolved — AI delegated: per-table allowlists are the direct control |
| 8 | Integration points | How should backup read control-plane tables? | A: reuse migrator URL · B: dedicated `openvault_backup` role · C: keep app reads | B — dedicated read-only role and `OPENVAULT_BACKUP_DB_URL`; backup fails closed if the connection cannot read control-plane tables | ✅ Resolved — user accepted moving backup |
| 9 | Behavioral gaps | How should join-token copy clear the clipboard? | A: 30-second best-effort clear · B: remove copy · C: file-only enrollment | A — credential copy mode with a 30-second clear that survives dialog close; keep the warning that clearing is best effort | ✅ Resolved — user accepted the 30-second clear |
| 10 | Behavioral gaps | How should scaffold hide project existence? | A: pre-authorize before lookup · B: collection visibility · C: blanket 404 | B — existing + visible → 403; existing + hidden or missing → identical 404; org admin keeps actionable 422 | ✅ Resolved — AI delegated: consistent with #44 |
| 11 | Security & compliance | How should rotation receipts be authenticated? | A: pre-rotation CSRF hash as second proof · B: disable successor recovery | A — require the pre-rotation `x-csrf-token`; cache only its hash; consume the receipt on recovery | ✅ Resolved — user accepted the second-proof option |
| 12 | Naming & terminology | New names | A: `audit_prune_authorizations`, `audit_prune_receipts`, `openvault_prune_audit_prefix`, `secret_consumer_summaries`, `openvault_backup`, `OPENVAULT_BACKUP_DB_URL` · B: other names | A — descriptive and consistent with existing naming | ✅ Resolved — AI delegated: naming only |
| 13 | Integration points | How does backup write its audit event when the dump connection is read-only? | A: reuse the backup role · B: second app-role audit connection | B — `runBackup` gets `auditDatabaseUrl` (the app URL); the dump uses `OPENVAULT_BACKUP_DB_URL` | ✅ Resolved — AI delegated: the read-only role must not gain write verbs |
| 14 | Security & compliance | Does the procedure enforce the export hash? | A: procedure compares the app-supplied hash to the file · B: the app records the hash in the authorization, receipt, and event | B — the app is the trusted exporter; the database cannot re-read the file. ST-9 drops the “export hash mismatch” clause | ✅ Resolved — AI delegated: state the trust boundary honestly |
| 15 | Integration points | How are the view and new tables represented in the schema lineage? | A: manual SQL only · B: `schema.ts` + generated migration | B — add tables and the view to `schema.ts`, generate the migrations and snapshot, then add the manual procedure migration | ✅ Resolved — AI delegated: keeps `db:types` and future codegen consistent |
| 16 | Behavioral gaps | What happens when the dialog closes before a clipboard denial is shown? | A: status inside the unmounted button · B: page-level status that survives the dialog | B — the identities page owns a status/toast; the timer and clear live in a shared credential-copy module | ✅ Resolved — AI delegated: the requirement must be observable after dialog close |
| 17 | Behavioral gaps | Should the clear skip when the page is unfocused? | A: skip · B: always attempt and report failure | B — always attempt `writeText("")`; a browser denial or focus problem is reported. Skipping leaves the token exposed in the normal copy-then-switch-apps workflow | ✅ Resolved — AI delegated: the control must run in the real workflow |

## Delegated provenance

> Policy version: 1
> Root invocation ID: `secfix-wave2-20261107-0146`
> Parent workflow: make-plan → preflight → exec-plan
> Delegated categories: algorithms, internal architecture/interfaces, failure/recovery design, persistence and reversible migrations, security mechanisms within the approved remediation policy, testing strategy, implementation sequencing, naming.
> Reserved categories: product behavior/scope, priorities/acceptance criteria, access and security policy, data retention, risk acceptance, public compatibility breaks, destructive migrations, credentials, deployment/publication.
> Permission state: implementation and `--auto-commit` authorized by the user objective.

## Gate evidence

- Every decision traces to the scanner report, the threat model, the seven issue bodies, or the accepted recommendation from the preceding review.
- No material item is deferred.
- Specification tests are ordered before implementation in `99-execution-plan.md`.
- The only new operational surface is the dedicated backup role and URL, directly required by finding #50.
- No new framework, queue, cache, or external service is introduced.

## Preflight provenance

> Iteration 2: three independent reviewers audited the plan against the code. Their Critical/Major findings are resolved in `00-preflight-report.md`; the corresponding plan sections were revised before execution. The main corrections are the backup audit connection, `audit.prune` detail allowlist, app-read startup assertion, schema-inventory test updates, pruner test helper, clipboard focus behavior, scaffold empty-entries path, session in-flight proof, and export-hash semantics.
