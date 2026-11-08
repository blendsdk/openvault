# Incident response runbook

This runbook covers a suspected disclosure, a compromised workload, a stolen
credential, a lost host, and a corrupted audit chain. It assumes the operator
has the keyring, the encrypted backup, the backup passphrase, and the release
image. There is no always-on second administrator.

## 1. Contain and preserve evidence

1. Do not delete logs, containers, volumes, or the audit table.
2. Export the audit window and the newest checkpoint before changing access:

   ```bash
   ov audit export --out /secure/openvault-audit-$(date -u +%Y%m%dT%H%M%SZ).ndjson
   ov audit checkpoint --out /secure/openvault-checkpoint-$(date -u +%Y%m%dT%H%M%SZ).json
   ov audit verify
   ```

3. Copy the database volume, keyring, internal CA certificate, and the current
   encrypted backup to the incident evidence store.
4. Record the time, the operator, and every command that changes state.

## 2. Revoke access

| Credential | Action |
|---|---|
| Service identity | `ov identity revoke <name> --project <project>` disables the principal, revokes every unexpired certificate, and invalidates unused join tokens in one transaction. |
| Agent files | A revoked agent receives 401/403, removes its managed files, and exits. Rotate the delivered values anyway. |
| CLI session | `ov auth sessions` lists the current principal's sessions; `ov auth sessions --revoke <id>` removes one; `ov auth logout` removes the current session. |
| Browser session | Browser sessions are in memory in v1.0. Restart `openvaultd` to clear every browser session, then change the affected user's password and remove unnecessary role assignments. |
| OIDC session | Disable the account at the identity provider and restart `openvaultd` to clear local sessions. |
| Database role | Change the app, purger, pruner, or migrator password and restart the affected service. |

Disabling the principal is the strongest local action. A disabled principal is
rejected by the browser, CLI, and agent paths.

## 3. Rotate keys and values

### Existing values

```bash
ov secret set <name> --project <project> --stdin
```

A write creates a new immutable version. The agent picks it up on the next
refresh. Rotate the consumer first if the old value must keep working during the
transition.

### Certificates

Generate or import a new version with the same name. The previous version
remains readable until retention; the newest unexpired version is the current
one.

### Workload CA

A compromised CA key is a full trust break. The v1.0 schema has one current CA
row and no supported online CA rotation. Treat the deployment as compromised:

1. Preserve evidence and the audit checkpoints.
2. Build a fresh deployment from a backup taken before the suspected compromise,
   or create a new empty deployment and migrate data through the API.
3. Generate a new internal CA, server TLS pair, proxy trust file, and JWT signing
   key.
4. Revoke every service identity and issue new join tokens.
5. Rotate every secret and certificate value.

There is no command that retires the old CA in place. Do not claim CA rotation as
an available control.

### KEK

1. Stop `openvaultd`.
2. Copy the current keyring to the evidence store. An old backup needs the
   keyring that existed when it was taken; KEK rotation removes old keys only
   after it verifies the new keyring.
3. Run:

   ```bash
   ov kek rotate --dry-run
   ov kek rotate --yes
   ```

4. Start `openvaultd`, sign in, read one secret per project, and run
   `ov audit verify`.
5. Keep the pre-rotation keyring with the matching old backups.

## 4. Restore after loss or destructive change

1. Stop the server.
2. Start PostgreSQL with an empty target, or use `--force` on a disposable
   target.
3. Set `OPENVAULT_RESTORE_DB_URL` to the migrator URL.
4. Restore:

   ```bash
   ov restore /secure/openvault-<date>.age \
     --agent-certificate /secure/openvault-agent-<date>.pem \
     --yes
   ```

5. Confirm the command reports the audit chain, one secret per project, the CA
   probe, and the pre-backup agent certificate.
6. Re-provision the server TLS pair if the restored CA differs from the one that
   signed the current certificate.
7. Start the server, run `ov audit verify`, and read one secret per project.

The restore drill in [`backup-restore.md`](/guide/backup-restore) is the
rehearsal for this procedure. RPO is 24 hours; RTO is 1 hour.

## 5. Host compromise

A host root compromise invalidates every local control. Rebuild the host rather
than cleaning it:

1. Preserve the evidence volumes and logs.
2. Provision a new host and a new PostgreSQL volume.
3. Restore the last known-good backup.
4. Generate a new internal CA and server TLS material.
5. Rotate the KEK and every secret and certificate value.
6. Revoke every service identity and issue new join tokens.
7. Change every human password and clear every session.
8. Verify the audit chain and the off-box checkpoints.

Do not restore a host root-compromised keyring into the new host and keep using
it without a full value rotation.

## 6. Audit-chain failure or truncation

A failed `ov audit verify` is a integrity incident.

1. Preserve the output and the first broken event id.
2. Export the retained events and every checkpoint.
3. Compare the retained tail with the newest off-box checkpoint.
4. If the prefix was pruned legitimately, verify the boundary checkpoint matches
   the authorized prune record.
5. If the chain cannot be reconciled, treat the deployment as compromised and
   follow the host-compromise procedure.

An empty chain with no checkpoints cannot prove prior existence. Off-box
checkpoints are the only anchor for that case.

## 7. Disclosure

1. Open a private security advisory through GitHub Security.
2. Do not post secret values, tokens, database URLs, or customer data in the
   advisory.
3. Include the affected version, the image digest, the observed behavior, and a
   reproduction that uses synthetic values.
4. Use the timelines in [`reporting.md`](reporting.md).
5. Publish a fixed release and a short advisory after the fix is available.

## 8. Break-glass checklist

- [ ] Keyring file (mode `0600`) and its matching backups
- [ ] Backup passphrase, stored separately from the archive
- [ ] Public internal CA certificate and server TLS material
- [ ] PostgreSQL migrator, app, purger, and pruner URLs
- [ ] The signed release image digest
- [ ] The last known-good audit checkpoint
- [ ] A tested restore drill from the current release

Break-glass is an offline procedure, not a second administrator. The keyring
plus an encrypted backup is the recovery authority.
