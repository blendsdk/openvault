# Requirements: Security Findings Wave 2

> **Document**: 01-requirements.md
> **Parent**: [Index](00-index.md)
> **Source**: [RD-14](../../requirements/RD-14-security-release.md) — security assurance parent

## Scope of this plan (delta view)

### In this plan

| ID | Requirement | Issue | AR Ref |
|---|---|---|---|
| R1 | `ov doctor` never attaches a stored bearer to an origin different from the credential document's origin. | #46 | AR-3 |
| R2 | Audit prefix deletion requires a short-lived, single-use authorization and a definer procedure; the pruner has no direct delete or checkpoint insert. | #47 | AR-4, AR-5 |
| R3 | Secret reads record `allow` only after envelope authentication, decryption, and encoding succeed; failures record an error event. | #48 | AR-6 |
| R4 | `openvault_app` reads only an explicit data-plane allowlist; a dedicated backup role reads control-plane tables. | #50 | AR-7, AR-8 |
| R5 | Join-token copy always attempts a 30-second best-effort clipboard clear that survives dialog close and reports the result on the page. | #49 | AR-9, AR-16, AR-17 |
| R6 | Scaffold hides project existence from callers without project visibility; visible and create-capable callers keep accurate errors. | #51 | AR-10 |
| R7 | Rotation-receipt recovery requires the pre-rotation CSRF token and is single use. | #52 | AR-11 |

### Deferred / out of this plan

- Off-box immutable reconciliation of every audit checkpoint. The receipt table makes local completion durable; off-box shipping is an operations decision.
- A general database-procedure framework. Only the one prune procedure is added.
- Removing the app role's ability to insert audit events or malformed secret versions. The read path now records integrity failures correctly; the app role is the trusted writer.
- Replacing clipboard delivery with a file/stdin enrollment flow. The 30-second clear is the selected control.

## Plan-local requirements

### Must Have

- [ ] R1: scheme, host, or port mismatch sends no `Authorization` header.
- [ ] R1: TLS and readiness checks still run unauthenticated on a mismatched origin.
- [ ] R2: direct `DELETE` on `audit_events` and `INSERT` on `audit_checkpoints` as `openvault_pruner` are denied.
- [ ] R2: the procedure rejects absent, expired, mismatched, and replayed authorizations without deleting.
- [ ] R2: a successful prune consumes one authorization and writes one receipt bound to the export hash.
- [ ] R3: a malformed newest secret version produces one error event and no allow event.
- [ ] R3: a valid read produces exactly one allow after decryption.
- [ ] R4: `openvault_app` cannot read principals, credentials, sessions, join tokens, OIDC links, assignments, workload certificates, consumers, or policy state.
- [ ] R4: secret consumer summaries still work through a restricted view.
- [ ] R4: `ov backup` uses `OPENVAULT_BACKUP_DB_URL` for the dump and the app URL only for the `backup.create` audit event.
- [ ] R4: backup fails closed if the dump connection is the app/auth role or cannot read control-plane tables.
- [ ] R4: `openvault_backup` exists on fresh and existing databases and has only `SELECT`.
- [ ] R4: production startup fails when `openvault_app` can still read control-plane tables.
- [ ] R5: the clipboard clear is always attempted after 30 seconds, even when the dialog closes or the page loses focus.
- [ ] R5: a denied clear shows a persistent page-level instruction to clear manually.
- [ ] R6: unassigned and foreign-project callers get identical 404 bodies for existing and missing project names.
- [ ] R6: an org administrator still gets 422 for a missing project with entries.
- [ ] R7: old cookie without proof or with the wrong proof gets 401 and no `Set-Cookie`; the in-flight shortcut also requires the proof.
- [ ] R7: old cookie with the pre-rotation CSRF token gets the same successor once.
- [ ] All security tests are written before implementation and fail for the expected reason.
- [ ] `pnpm verify` and the affected integration suites pass.

### Should Have

- [ ] The denial audit for scaffold writes exactly one decision with the real reason.
- [ ] The prune receipt is visible to the existing audit query path for operations.

### Won't Have (Out of Scope)

- Multi-tenant policy redesign.
- A new database, cache, queue, or external service.
- Changes to the external review gate.

## Acceptance Criteria

1. [ ] All seven issue regression tests fail before the fix and pass after it.
2. [ ] `openvault_pruner` cannot delete directly or insert checkpoints.
3. [ ] `openvault_app` cannot read control-plane credential material.
4. [ ] Backup uses the dedicated read role for the dump and the app role for the audit event; it fails closed on the app/auth role or missing privileges.
5. [ ] Doctor sends no bearer to a mismatched origin.
6. [ ] Secret integrity failures produce error evidence, not allow evidence.
7. [ ] Scaffold hidden/missing responses are identical.
8. [ ] Rotation recovery requires the CSRF proof and is single use.
9. [ ] `pnpm verify` passes.
10. [ ] Full integration passes against PostgreSQL 16 and 17.
11. [ ] Threat model, limitations, reference docs, and evidence matrix are updated.

## Compatibility Notes

- R1 changes doctor behavior only for override origins that differ from the stored credential. Normal use is unchanged.
- R2 adds two tables and one function. Existing prune commands keep working; the pruner role loses direct table privileges and must be re-granted `EXECUTE`.
- R4 adds `OPENVAULT_BACKUP_DB_URL` and `openvault_backup`. Production backups must use the new role for the dump and `OPENVAULT_DB_URL` for the audit event. A connection that is the app/auth role or cannot read control-plane tables fails instead of producing a partial archive.
- R5 adds a best-effort clear; non-credential copy remains unchanged. The clear is attempted even when the page is unfocused.
- R6 changes scaffold denials from 403/422 to a uniform 404 for callers without visibility. Authorized administrators keep the existing actionable errors, including the empty-entries project-create path.
- R7 changes only lost-response recovery: the browser already sends `x-csrf-token`, so normal refresh is unchanged. A lost recovery response cannot be retried after the receipt is consumed; the operator reauthenticates.
