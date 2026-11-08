# Known limitations

These are accepted for v0.1. They are documented so reviewers do not mistake them for bugs.

1. **Node memory.** Node cannot guarantee zeroization. Buffers are cleared where practical,
   but plaintext may remain in the heap until garbage collection.
2. **Application compromise.** Any secret mounted into a container can be read by code in
   that container. OpenVault limits blast radius; it cannot make a compromised workload
   safe.
3. **Host root.** Root on the vault host can read the KEK, tmpfs files, and plaintext in
   memory. External KMS/HSM is the future answer.
4. **Swap.** tmpfs can be swapped. Disable swap or use encrypted swap on the vault host.
5. **Audit truncation.** Tail truncation is detected while a surviving checkpoint or a newer
   event/checkpoint still references the deleted tail. Deleting the prefix at a legitimate
   prune boundary looks the same as an authorized prune; only an off-box checkpoint anchor
   distinguishes the two. A database administrator who deletes every event and every
   checkpoint leaves an empty chain that cannot prove prior existence. The append-only
   trigger only defends against a role that is not the table owner and not a superuser.
6. **Single node.** No high availability. RPO 24 hours with daily encrypted backups and
   off-box checkpoint export; RTO 1 hour. The schedule is operator-managed, not an
   always-on backup daemon.
7. **Environment injection.** Environment variables cannot update a running process and
   leak through `/proc`, children, and crash dumps. Prefer files.
8. **Browser sessions.** Sessions live in memory in v0.1. A restart signs users out.
9. **Certificates.** OpenVault stores and generates self-signed certificates; it is not a
   public CA. ACME is a later phase.
10. **Dynamic credentials.** No database user or cloud token leasing.
11. **Certificate UI.** Certificate management is API/CLI in v0.1; screens are v0.2.
12. **Remote hosts.** Agents must run on the same Docker host as the vault in v0.1.
13. **Kubernetes and KMS.** Later phases.
14. **Audit pruning.** Pruning is a manual maintenance command. It verifies the retained
    chain, exports the prefix, writes a boundary checkpoint, and then deletes under a
    dedicated `openvault_pruner` session. Export checkpoints off-box to anchor the boundary.
15. **TypeScript 7.** The stack is verified in this repository, but the ecosystem around
    the native compiler is still maturing. Biome replaces typescript-eslint.
16. **Single-instance sessions.** Browser sessions, OIDC transient state, and login/refresh
    rate-limit counters are process-local. CLI refresh families, signing keys,
    workload certificates, and the CA key are stored in PostgreSQL and are shared across
    instances. Lockout state is stored in PostgreSQL and is
    shared. A multi-instance deployment would need a shared session/state store; the reference
    stack runs one server. A restart signs browser users out but does not erase CLI families.
17. **OIDC state locality.** The callback must reach the process that handled the login
    redirect. A load-balanced deployment without shared state cannot complete the flow.
18. **Lockout denial of service.** Anyone who knows an account email can lock it with five
    bad guesses. v0.1 has no administrator unlock endpoint; the lock expires after 15 minutes.
    The per-account login bucket can also deny the identifier for up to one hour after ten
    attempts, even after the 15-minute lockout expires.
19. **Forced-change reuse.** The forced-change flow accepts the current password as the new
    password. The policy enforces a 12–1024 character length range, not a difference from the
    current password; a future policy can add one.
20. **Password-hash queue.** Argon2 derivations run on the Node threadpool with no
    application-level admission queue. The per-IP and per-account limits bound the login
    surface, but a distributed flood can still queue work behind legitimate logins.
21. **Signing-key cache freshness.** A process refreshes the current/previous signing-key
    snapshot when it is older than 30 seconds. A rotation in another process is observed within
    that bound; a due previous key is rejected at the overlap boundary even while the cached
    snapshot still lists it. A previous public key is imported only when it derives from the
    KEK-authenticated wrapped seed; a mismatch is ignored and current-key verification continues.
    There is no operator-facing JWT signing-key rotation command in this release. KEK re-wrap is
    provided separately by `ov kek rotate`.
22. **CLI refresh counters.** Refresh IP and family buckets are in memory. A restart clears
    them, and a multi-instance deployment does not share them.
23. **Agent join and renewal counters.** Join IP and renewal principal/IP buckets are in
    memory. A restart clears them, and a multi-instance deployment does not share them.
24. **Workload CA custody.** The CA key is wrapped by the KEK and stored in PostgreSQL, but
    the KEK and CA key are on the same host. There is no HSM. Per-certificate revocation and
    identity re-enable are out of scope; identity revoke revokes all credentials. Secrets
    already delivered to a container cannot be retracted; rotate the values after a
    compromise.
25. **Renewal replay cache.** The five-minute renewal replay cache is process-local. A server
    restart or a retry after five minutes requires a new join token. The old certificate
    remains valid for data until expiry, but it cannot renew.
26. **Project deletion.** A soft-deleted project hides its secrets and certificates and
    neither can be purged through the API until an operator restores the project. There is no
    project-recovery route in v0.1.
27. **Protected deleted names.** Purge protection is one-way. A protected secret or
    certificate can never be purged, so its name remains reserved permanently even after
    retention. Recover it before retention or use a different name.
28. **Purge evidence window.** The destructive secret or certificate purge runs on a dedicated
    `openvault_purger` session, separate from the audit chain. The actor-attributed authorization
    event is written before the delete, and a completion event follows a successful delete. A
    crash or audit outage can leave authorization without completion; that means the outcome is
    unknown, not that the purge definitely succeeded.
29. **Idempotency retention.** Idempotency rows expire after 24 hours but are not removed by a
    scheduler; cleanup is an operational task. A KEK rotation invalidates outstanding keys and
    returns 409 on replay.
30. **Envelope v2 precondition.** Secret and certificate envelopes use the v2 AAD. This is a
    one-way change for this pre-release repository: both version tables must be empty before
    first boot. A database with v1 rows needs a migration or restore plan.
31. **In-flight reads.** A value or certificate chain read that has already resolved the
    project and object may finish after a concurrent soft delete or purge commits. The delete
    is immediate for new requests; a read already in flight can still return the material it
    decrypted or loaded.
32. **Certificate SAN types.** Import supports DNS, IP, URI, and email SANs. A certificate with
    another SAN type (for example `otherName`) is rejected with 422 rather than stored with a
    lossy representation.
33. **Certificate write idempotency.** Import/generate do not accept `Idempotency-Key`. A retry
    can create another immutable version; pass `expectedVersionId` to reject a stale renewal.
    Retained versions are capped at 1,000.
34. **Private-key memory.** A generated or imported private key exists briefly as a PEM string
    during response construction; JavaScript strings cannot be zeroed. The PKCS#8 DER buffer is
    zeroed on every success and failure path, and the key is never logged or cached.
35. **Expiry delivery.** The webhook is at-least-once: a crash after send but before mark-sent
    can duplicate a warning. The payload carries a stable `eventId` for receiver dedupe. A
    failed delivery is retried on a later run, normally the next daily run. The scan rechecks
    eligibility after claiming, but a delete or renewal can still commit immediately before the
    webhook, so one extra warning is possible; new scans exclude the resource. DNS rebinding is
    possible for an operator-configured URL; the URL is not user-controlled and is never logged.
36. **Expiry webhook trust.** The optional HMAC signature proves possession of the shared
    secret and includes a timestamp, but the receiver must enforce its own replay window and
    dedupe by `eventId`.
37. **Certificate agent access.** A certificate request on the agent listener is denied; a
    same-project agent receives 401 and a project-mismatched certificate is rejected 403 by the
    existing agent guard. No certificate data is returned either way.
38. **Certificate history surface.** v0.1 has no certificate versions-list route and no
    certificate consumers. A client can read a selected version with `?version=<ulid>` when it
    knows the version id from a write or read response.
39. **Wrapper same-UID trust.** In wrapper mode the application runs as the same UID as the
    agent and can read the agent state directory, private key, and status file. Wrapper mode is
    opt-in and requires a fully trusted application; sidecar mode is the secure default. The
    child environment removes every `OPENVAULT_*` variable, but filesystem isolation without a
    separate UID is not possible.
40. **Expired-certificate heartbeat gap.** An expired client certificate is rejected before a
    principal is available, so the agent cannot update the consumer state on that request.
    Revocation sets `failed`; two-thirds renewal avoids expiry in normal operation.
41. **Network-failure state lag.** A network failure cannot reach the server. The next
    successful fetch or aggregate heartbeat corrects the consumer state.
42. **Renewal replay persistence.** The server replay cache is process-local. A server restart
    or a retry after five minutes can require a new join token; the agent keeps delivering with
    the old certificate until expiry. The agent records this as `degraded` and does not remove
    files on `renewal_not_current`.
43. **Consumer metadata character set.** The shared consumer contract accepts 1–100 characters
    for Compose project/service. The agent validates safe values, but a direct malicious join
    could store control characters. Tightening the shared contract is deferred to the identity
    surface.
44. **Release images.** The repository builds server, agent, and web images and the release
    workflow scans, signs, and attests them. Production images are published by a deliberate
    operator action. The OpenAI Codex Security scan is manual and advisory; it is not an
    automated release gate. Alpha images are explicitly labelled not for production. The
    scaffold's image tag is replaced by the signed digest for production.
45. **Scaffold serialization.** Grant reconciliation and join-token rotation are serialized by a
    per-identity in-process mutex. This covers the single-instance v0.1 deployment. A
    multi-instance deployment would need a database advisory lock for the same guarantee.

46. **Native Windows CLI credentials.** The `ov` credential store fails closed with
    `credential_store_unsupported` on native Windows because Node cannot enforce an
    owner-only ACL without an external, untested command. WSL uses the POSIX path with
    `0700`/`0600` checks.
47. **Logical backup format.** The v0.1 backup uses a portable logical JSON row dump rather
    than `pg_dump` custom format. This avoids a host `pg_dump` dependency; a future release can
    add a native dump format. The archive is still age-encrypted and checksum-verified.
48. **Restore ownership.** Restore and KEK rotation disable immutability triggers inside a
    transaction. They require an owner/migrator role; the application role fails with
    `restore_requires_owner` or `kek_rotation_requires_owner`.
49. **Rotation maintenance window.** A running server holds the old keyring in memory. The
    command refuses while `openvault_app` or `openvault_auth` is connected, but a deployment
    that gives the server different role names bypasses that check. Stop the server before
    `ov kek rotate`; otherwise a late write can use the old `kek_id` after the verification
    step. The old key is removed only after the CLI's own count check.
50. **Bootstrap credential rotation.** The v0.1 bootstrap administrator is created with
    `must_change=false` so the reference stack can complete its first login without an extra
    interactive step. The web UI includes a password-change screen and the server enforces the
    gate when `must_change` is set. Change the bootstrap password immediately and remove the
    one-time `0600` file after first use. The file lives outside the runtime container's keyring
    mount, so an application compromise does not read it.
51. **Generated contract schema source.** `pnpm api:check` detects route and artifact drift
    against the route metadata table. A controller schema change that leaves the table untouched
    is caught by the representative command end-to-end tests, not by `api:check` alone.
52. **Proxy and internal CA separation.** `ov login` and `ov doctor` trust the proxy's public
    root CA; the OpenVault internal CA signs the agent listener and the proxy-to-server
    upstream. Operators must keep the two files distinct. Using the wrong file produces a
    clear TLS verification failure, never a silent downgrade.
53. **CLI run manifest.** `ov run` uses a CLI-specific manifest profile rather than the agent
    manifest verbatim. It shares the entry grammar and safety bounds but omits agent-only
    fields such as `service`, `refresh`, and `output_dir`.
54. **Credential file at rest.** CLI tokens are stored in a `0600` JSON file until logout or
    expiry. Anyone who can read the file as the current user can use the session; the lock and
    permission checks protect against other users and concurrent processes, not a compromised
    account.
55. **Restore verification window.** `ov restore` commits the restored rows and then verifies the
    audit chain and sample secrets/CA. A failure in that post-commit verification leaves the
    restored rows for inspection; the command reports the failure rather than silently rolling
    back. If publishing the staged keyring/CA fails after commit, the staged files remain for
    manual recovery. Run restore only during a maintenance window with the server stopped.
56. **Local login reloads the document.** The BlendSDK auth provider learns a session from
    `GET /v1/auth/me`, so a successful local login or password change performs one same-origin
    reload instead of keeping the previous document's in-memory state. The reload is
    intentional and does not add a network round trip beyond the session check.
57. **Consumers are derived.** The v0.1 API has no project-level consumer list. The consumers
    screen reads identity detail, which embeds the latest self-reported consumer. Hostnames,
    manifest hashes, and host paths are not displayed.
58. **Inline styles in the UI CSP.** Fluent UI's Griffel runtime injects style elements, so the
    UI-enabled CSP allows `style-src 'unsafe-inline'`. Scripts remain same-origin and there is
    no `unsafe-eval`. API-only deployments keep the deny-by-default policy.
59. **Accessibility automation scope.** Axe runs in Vitest/jsdom on login, secret detail, and
    audit. jsdom has no layout engine, so color-contrast is excluded there; real-browser
    Playwright checks belong to release assurance.
60. **Certificate screens are CLI-only.** The web UI deliberately excludes certificate
    lifecycle, private-key reads, backup/restore, and KEK rotation. Those remain CLI-only in
    v0.1.
61. **Project deletion has no browser recovery.** The projects screen can soft-delete a
    project, but v0.1 has no process to restore a deleted project in the UI. The operator
    must restore from backup. The confirmation text states this instead of implying a
    recoverable secret state.
62. **Clipboard clearing is best effort.** The browser can deny clipboard writes or skip the
    delayed clear when the page is not focused. The UI reports that outcome; it cannot
    guarantee that another application has not already read the clipboard.
63. **Agent certificate restore check.** The v0.1 schema does not store agent leaf certificate
    PEMs. A restore that needs the pre-backup agent check supplies the certificate saved by the
    drill with `--agent-certificate`; without it the CA probe still verifies the signing key.
64. **Split web container.** The reference stack serves the SPA from a separate nginx container
    so the API and UI have independent hardening. The server can also serve the SPA when
    `OPENVAULT_WEB_ROOT` points at a build; the Compose stack assigns the UI CSP to the web
    container.
65. **Create-once role bootstrap, repeated ensure.** `deploy/postgres/init-roles.sh` runs only
    on a fresh PostgreSQL data directory. The `openvault-roles` job runs
    `ensure-auth-role.sql`, `ensure-backup-role.sql`, and `grants.sql` on every deployment, so
    an existing volume receives the new roles and the current privileges. Re-run `grants.sql`
    after a migration that adds a table the runtime, purge, prune, or backup path must access.
66. **Bind-mount ownership.** The reference stack uses host directories, not Docker-managed
    volumes, so the operator can set the exact non-root UID and mode. `prepare.sh` needs root
    (or equivalent) once; a rootless Docker host must map the same UIDs.
67. **Manual security scan is advisory.** The OpenAI Codex Security scan needs a specific
    runtime environment that is not available in CI/CD. It is run manually from time to time,
    recorded in `docs/security/external-review.md`, and is not an automated or release-blocking
    gate. It cannot replace human judgment for business context or operational procedures.
68. **Off-box retention.** The systemd timers run on the vault host and push to an operator
    destination. If the host and the destination are lost together, the RPO is not met. Keep the
    checkpoint anchor on independent storage.
69. **Browser refresh retry receipt.** Browser refresh keeps a ten-second receipt for the
    previous session secret so a lost response can be retried. Recovery requires the
    pre-rotation `x-csrf-token`, which is not stored in the cookie, and the receipt is consumed
    on the first successful recovery. A cookie thief without the CSRF token cannot use the
    window. If the single recovery response is also lost, the operator must reauthenticate.
    CLI refresh reuse detection remains strict.
70. **CA rotation.** There is no supported online CA rotation command. A suspected CA
    compromise requires a fresh deployment, a restore from a pre-compromise backup, new
    server TLS material, new agent join tokens, and re-issued workload identities.
71. **Lost join response.** The agent persists its identity only after the join response. If the
    response is lost after the server commits the token, a retry receives `join_token_used` and
    the operator must issue a new token. Join replay is bounded by the one-time token instead.
72. **Restore freshness.** Restore restores an archive as-is. An old archive can undo later
    revocations and role removals. The command records the archive hash and timestamp in the
    audit event, but an off-box checkpoint comparison and an anti-rollback flag are follow-up
    work.
73. **OIDC identity linking.** There is no administrator route to link a verified OIDC identity
    to an existing principal. A collision is denied rather than auto-linked; linking requires a
    controlled database procedure.
74. **Prune evidence window.** The boundary checkpoint is written before the prefix delete. The
    application creates a short-lived single-use authorization bound to the boundary hash, count,
    export SHA-256, database, and cutoff. The `SECURITY DEFINER` procedure consumes it, deletes
    the prefix, and writes a completion receipt in one transaction. A crash after the procedure
    can still leave the chained `audit.prune` event unwritten, but the receipt and authorization
    are durable completion evidence. The pruner login role has no direct table authority.
75. **Agent renewal second factor.** Renewal accepts the current certificate and a fresh key.
    A stolen certificate can renew until an administrator revokes the identity. Per-certificate
    revocation or a second factor for key-changing renewal is follow-up work.
76. **Backup read exposure.** `openvault_backup` can read every table, including password,
    refresh-token, join-token, and OIDC-link verifiers, because a logical backup must capture
    the full database. The role is read-only, `NOINHERIT`, separate from the server process, and
    receives no write or DDL privilege. Treat `OPENVAULT_BACKUP_DB_URL` as a high-value
    credential and rotate it with the other database secrets.
77. **Consumer summary view scope.** `openvault_app` can read `secret_consumer_summaries` for
    every project, not only the project in the current request. The view exposes only compose
    project/service names and last-seen timestamps; row scoping remains an application
    responsibility, as it is for the other data-plane tables.
78. **Signing-key insert availability.** The runtime role can still insert a `current` signing
    key because rotation uses the application connection. A database writer can therefore create
    a malformed current row and cause a fail-closed 503 for CLI token issuance and verification.
    It cannot forge a valid key without the KEK, so this is an availability risk, not token
    substitution.
