# Current State: Security Findings Wave 2

> **Document**: 02-current-state.md
> **Parent**: [Index](00-index.md)

## Existing Implementation

The repository is a TypeScript/BlendSDK monorepo. The server uses PostgreSQL with separate `openvault_app`, `openvault_auth`, `openvault_purger`, and `openvault_pruner` roles. The scanner verified all seven findings at `cb81edba4079fc4c6fb929be95a0bb6bfa794f1a`.

### Relevant Files

| File | Purpose | Changes Needed |
|---|---|---|
| `apps/cli/src/commands/doctor.ts` | Diagnostic probes | Compare selected origin with the credential before attaching a bearer |
| `apps/cli/src/client/authenticated.ts` | Existing origin binding | Reuse or extract the origin rule |
| `apps/server/src/audit/prune-connection.ts` | Pruner delete transaction | Call the constrained procedure with an authorization id |
| `apps/server/src/audit/audit-prune.ts` | Verify/export/checkpoint/prune flow | Create authorization after checkpoint; hash export; handle receipt |
| `apps/server/src/audit/cli.ts` | Prune command wiring | Pass the authorization callback |
| `deploy/postgres/grants.sql` | Role privileges | Remove pruner table rights; explicit app allowlist; backup role |
| `deploy/postgres/roles.sql`, `init-roles.sh` | Role creation | Add `openvault_backup`; remove app default privileges |
| `deploy/postgres/ensure-*.sql` | Existing-database role upgrade | Add backup role upgrade |
| `deploy/compose/compose.yaml`, `prepare.sh` | Reference stack | Add backup password/URL secret wiring |
| `apps/server/src/secrets/service.ts` | Secret read | Move allow after decrypt; record error on failure |
| `apps/server/src/secrets/repository.ts` | Consumer summary join | Read the restricted view |
| `apps/server/src/ops/backup.ts`, `apps/cli/src/commands/backup.ts` | Logical backup | Use `OPENVAULT_BACKUP_DB_URL` for the dump and the app URL for the audit event; fail closed on the app/auth role or missing privileges |
| `apps/server/src/audit/actions.ts` | Audit detail allowlist | Add `authorizationId` and `exportSha256` to `audit.prune` |
| `apps/server/src/db/privileges.ts` | Production startup assertion | Add app `SELECT` denial checks for control-plane tables |
| `apps/server/tests/integration/roles.spec.test.ts` | Role contract | Rewrite the app/pruner assertions; add the backup role |
| `apps/server/tests/integration/migrations.spec.test.ts`, `schema.spec.test.ts`, `schema-identity.impl.test.ts` | Schema inventory | Update migration/table/view counts and inventory |
| `apps/server/tests/integration/helpers/pruner.ts`, `audit-harness.ts` | Test fixtures | Grant `EXECUTE` only; reset the new prune tables |
| `apps/server/src/scaffold/service.ts` | Scaffold | Apply collection visibility |
| `apps/server/src/auth/sessions.ts` | Rotation receipts | Store CSRF hash; require proof; consume receipt |
| `apps/server/src/controllers/auth.ts` | Browser refresh | Pass the `x-csrf-token` proof |
| `apps/web/src/components/copy.tsx` | Copy button | Add credential mode with scheduled clear |
| `apps/web/src/pages/identities-page.tsx` | Join-token dialog | Use credential mode |
| `apps/server/src/database/schema.ts`, `apps/server/migrations/` | Schema | Add prune authorization/receipt tables, procedure, view |
| Tests | Regression coverage | Add the seven finding suites |
| `docs/security/*`, `docs/reference/*`, `docs/guide/*` | Claims and references | Update the threat model, limitations, roles, backup, and API docs |

## Gaps Identified

### Gap 1: Doctor trusts an override origin

`doctor.ts:144-159` selects the transport from `--url` or `OPENVAULT_URL`; `:202-214` loads the credential and attaches the bearer unconditionally. `authenticated.ts:53-67` has the correct origin rule but doctor does not use it.

### Gap 2: Pruner has primitive delete authority

`grants.sql:52-53` grants `SELECT, DELETE` on `audit_events` and `SELECT, INSERT` on `audit_checkpoints`. `prune-connection.ts:59-92` performs the delete after application checks. The trigger accepts the GUC. A stolen pruner credential can delete a prefix without export or completion evidence.

### Gap 3: Secret allow precedes integrity checks

`secrets/service.ts:587-608` writes the allow decision, then decrypts. The catch does not write an error event. A malformed newest version leaves a false allow.

### Gap 4: App role reads control-plane material

`grants.sql:13` grants all tables to the app role. `secrets/repository.ts:710-728` joins consumers, principals, and assignments on the app connection. `backup.ts:81-90` uses `OPENVAULT_DB_URL` for both the dump and the `backup.create` audit event, so it depends on the broad read and write access. The fix must split the dump connection from the audit connection.

### Gap 5: Generic copy retains join tokens

`copy.tsx:27-39` writes text without a clear timer. `identities-page.tsx:222-226` uses it for the join token. `secret-detail-page.tsx:142-174` already has the desired 30-second pattern.

### Gap 6: Scaffold resolves before authorizing

`scaffold/service.ts:123-124` resolves first; `:240-246` returns 422 for a missing project; `:274-277` returns 403 for an existing unauthorized project.

### Gap 7: Receipt recovery trusts only the rotated cookie

`sessions.ts:133-147` returns the receipt for the old cookie hash; `:387-415` stores the full successor; `controllers/auth.ts:269` calls `rotate` with no second proof. The old cookie does not resolve, so CSRF middleware does not run.

## Dependencies

### Internal Dependencies

- Schema migration → grants → integration grant tests → backup command.
- Authorization table + procedure → prune connection → prune command.
- Restricted view → secret consumer route → web consumer page.
- Session receipt → refresh controller → web refresh (already sends the header).

### External Dependencies

None added.

## Risks and Concerns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Explicit grants miss a runtime table | Medium | High | Full integration suite; grant test; fail-closed errors |
| Backup produces a partial archive | Medium | High | Privilege preflight fails closed; dedicated role in Compose docs |
| Procedure bypass or search-path injection | Low | High | `SECURITY DEFINER`, fixed `search_path`, schema-qualified names, `session_user` check |
| Receipt proof breaks a legitimate retry | Low | Medium | The web client already sends `x-csrf-token`; tests cover the lost-response path |
| Scaffold normalization hides actionable admin errors | Low | Low | Org admin keeps the 422 create path |
| Clipboard clear blocked by browser | Medium | Low | Best-effort status instructs manual clearing |
| Migration snapshot drift | Low | Medium | Use the codegen generate flow, add the view to `schema.ts`, and commit regenerated types |
| Schema inventory tests fail | High | Medium | Update the migration/table/view counts and inventory in the same phase; treat them as schema-contract updates, not oracle changes |
| Backup audit write fails on a read-only role | High | High | Split the dump and audit connections; test a real backup-role dump |
| Pruner test helper still grants `DELETE` | High | Medium | Grant `EXECUTE` only and add negative assertions |
