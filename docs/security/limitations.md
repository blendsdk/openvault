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
5. **Audit truncation.** A database administrator can truncate the audit table. The HMAC
   chain detects it only if a checkpoint survives or was exported off-box.
6. **Single node.** No high availability. RPO 24 hours with daily backups; RTO 1 hour.
7. **Environment injection.** Environment variables cannot update a running process and
   leak through `/proc`, children, and crash dumps. Prefer files.
8. **Browser sessions.** Sessions live in memory in v0.1. A restart signs users out.
9. **Certificates.** OpenVault stores and generates self-signed certificates; it is not a
   public CA. ACME is a later phase.
10. **Dynamic credentials.** No database user or cloud token leasing.
11. **Certificate UI.** Certificate management is API/CLI in v0.1; screens are v0.2.
12. **Remote hosts.** Agents must run on the same Docker host as the vault in v0.1.
13. **Kubernetes and KMS.** Later phases.
14. **Audit pruning.** Pruning with off-box checkpoints is a manual maintenance command.
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
    snapshot still lists it. There is no operator-facing signing-key rotation command in this
    release; KEK re-wrap and operational rotation are planned for a later release.
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
