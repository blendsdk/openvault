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
16. **Single-instance sessions.** Browser sessions, OIDC transient state, and login
    rate-limit counters are process-local. Lockout state is stored in PostgreSQL and is shared
    across instances. A multi-instance deployment would need a shared session/state store; the
    reference stack runs one server. A restart signs users out.
17. **OIDC state locality.** The callback must reach the process that handled the login
    redirect. A load-balanced deployment without shared state cannot complete the flow.
18. **Lockout denial of service.** Anyone who knows an account email can lock it with five
    bad guesses. v0.1 has no administrator unlock endpoint; the lock expires after 15 minutes.
19. **Forced-change reuse.** The forced-change flow accepts the current password as the new
    password. The policy enforces a 12–1024 character length range, not a difference from the
    current password; a future policy can add one.
20. **Password-hash queue.** Argon2 derivations run on the Node threadpool with no
    application-level admission queue. The per-IP and per-account limits bound the login
    surface, but a distributed flood can still queue work behind legitimate logins.
