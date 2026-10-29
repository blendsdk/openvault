# RD-13: Backup, Rotation, and Operations

> **Document**: RD-13-backup-rotation-ops.md
> **Status**: Draft
> **Created**: 2026-10-29
> **Project**: OpenVault
> **Depends On**: RD-02, RD-08, RD-09
> **CodeOps Artifact Schema**: 1

## Feature Overview

This document defines the operational lifecycle: encrypted backup and restore, KEK rotation
without re-encrypting values, secret rotation, certificate renewal, session rotation, the
reference Compose stack, container hardening, logs, health, migrations, and the documented
break-glass procedure.

## Functional Requirements

### Must Have

- [ ] `ov backup --out <path>` creates an encrypted archive containing the PostgreSQL dump,
  keyring, configuration manifest, and audit checkpoints.
- [ ] The archive is encrypted with age using a passphrase or recipient key.
- [ ] `ov restore <archive>` verifies the manifest, restores the dump, writes the keyring,
  runs migrations, and verifies the audit chain.
- [ ] A restore drill is documented and tested: backup, destroy, restore, verify, read one
  secret per project.
- [ ] `ov kek rotate` generates a new KEK, re-wraps every DEK, audit key, CA key, and JWT key,
  updates `kek_id`, and removes the old key only after verification.
- [ ] Values are never re-encrypted during KEK rotation.
- [ ] Secret rotation creates a new version; the agent picks it up on refresh.
- [ ] Certificate renewal creates a new version; expiry warnings fire at 30/14/7 days.
- [ ] Browser session refresh rotates the session id; CLI refresh rotates the token pair.
- [ ] The reference Compose stack runs server, Postgres, proxy, and UI on one host.
- [ ] The server is not published directly; only the proxy exposes 443.
- [ ] `vault_net` and `db_net` are internal; only the agent joins `vault_net` and an app
  network.
- [ ] Containers run as non-root, with read-only root filesystems where possible,
  `cap_drop: ALL`, `no-new-privileges`, and resource limits.
- [ ] PostgreSQL uses a persistent volume and a healthcheck.
- [ ] Structured JSON logs with redaction and request ids.
- [ ] `/health` and `/ready` behave as defined in RD-02.
- [ ] Migrations run at startup or via `ov migrate`, idempotently.
- [ ] RPO 24 hours; RTO 1 hour; documented.
- [ ] Break-glass recovery uses the keyring and an encrypted backup; there is no always-on
  second admin.
- [ ] The bootstrap password is never printed to logs; it is a one-time `0600` file or an
  operator-supplied file.
- [ ] Images are pinned by digest in the reference stack once published.

### Should Have

- [ ] `ov doctor` checks DB, keyring, TLS, clock skew, and backup age.
- [ ] A scheduled checkpoint export to an off-box location.
- [ ] Log rotation limits in the Compose file.

### Won't Have (Out of Scope)

- High availability, replication, or multi-region.
- Remote Docker hosts.
- Kubernetes or CSI.
- External KMS/HSM.
- Automated ACME.

## Technical Requirements

### Backup archive

```text
openvault-backup/
├── manifest.json          # schema version, server version, timestamp, checksums
├── database.dump          # pg_dump custom format
├── keyring.json.age       # encrypted keyring
├── config.json            # redacted config
└── checkpoints.ndjson     # audit checkpoints
```

The archive itself is age-encrypted. The backup passphrase and keyring passphrase are stored
separately. The manifest records SHA-256 for every file.

### Restore sequence

1. Verify the archive and manifest checksums.
2. Start an empty PostgreSQL and server.
3. Restore the dump.
4. Write the keyring with mode `0600`.
5. Run migrations.
6. Verify the audit chain.
7. Read one secret per project.

### KEK rotation

1. Generate a new 32-byte key with the next id; make it current.
2. In batches, unwrap and rewrap every DEK, audit key, CA key, and JWT key; update `kek_id`.
3. Record `kek.rotate` start and completion events.
4. Verify a sample of old and new records.
5. Remove the old key only after verification.

### Compose hardening

- `proxy`: `cap_drop: ALL`, `cap_add: NET_BIND_SERVICE`, read-only rootfs, no secrets in env.
- `openvaultd`: non-root UID, read-only rootfs, tmpfs `/tmp` and `/run`, `cap_drop: ALL`,
  `no-new-privileges`, memory/CPU limits, no Docker socket.
- `postgres`: non-root where possible, persistent volume, healthcheck, no published port.
- DB password supplied through a file or Docker secret, not `POSTGRES_PASSWORD` in `.env`.
- Base images pinned by digest.

## Integration Points

- RD-02 supplies config, TLS, and readiness.
- RD-08 and RD-09 supply data and envelope fields.
- RD-10 supplies agent delivery and tmpfs.
- RD-11 exposes backup/restore/rotate commands.
- RD-14 verifies signing, SBOM, scan, and external review.

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|---|---|---|---|---|
| Backup encryption | Plain / age | age | Offline, strong, simple | AR-6 |
| Keyring in backup | Separate / included | Included in encrypted archive | Restore must work | AR-6 |
| KEK rotation | Re-encrypt values / rewrap only | Rewrap only | Fast, no plaintext exposure | AR-6 |
| HA | v0.1 / later | Later | Scope control | AR-30 |
| Container security | Default / hardened | Hardened | Secrets product baseline | AR-22 |
| RPO/RTO | 24h/1h / other | 24h/1h | Documented target | AR-11 |

## Security Considerations

- **Data sensitivity:** the backup contains all ciphertext and the keyring.
- **Input validation:** archive path, manifest, checksums, keyring, passphrase file.
- **Authentication & authorization:** backup/restore/rotate require org admin.
- **Injection risks:** `pg_dump` and `age` invoked with argument arrays, not a shell.
- **Encryption needs:** age archive, keyring passphrase, TLS.
- **Rate limiting:** admin actions; audit every attempt.
- **Infrastructure:** non-root, read-only rootfs, cap drop, no published DB, no secrets in
  env or logs.

## Acceptance Criteria

1. [ ] `ov backup` produces an archive that decrypts only with the correct passphrase and
   contains the manifest, dump, keyring, config, and checkpoints.
2. [ ] `ov restore` into a fresh stack restores every secret and certificate, runs migrations,
   and verifies the audit chain.
3. [ ] A corrupted archive fails checksum verification and changes nothing.
4. [ ] KEK rotation re-wraps all records; old and new records decrypt; value ciphertext is
   byte-identical before and after.
5. [ ] Removing the old key after rotation makes old `kek_id` records unreadable, as expected.
6. [ ] Secret rotation creates a new version and the agent refreshes it.
7. [ ] Certificate renewal creates a new version and expiry warnings fire once per threshold.
8. [ ] Compose services run as non-root with the specified hardening; no container mounts the
   Docker socket.
9. [ ] `/ready` fails when PostgreSQL or the keyring is unavailable.
10. [ ] The restore drill completes within the documented RTO and meets the RPO.
11. [ ] The bootstrap password is absent from logs and present only in the one-time file.
12. [ ] Security requirements verified: archive encryption, keyring permissions, container
    hardening, no secret in env/logs.
