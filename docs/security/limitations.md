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
26. **Project deletion.** A soft-deleted project hides its secrets and certificates and
    neither can be purged through the API until an operator restores the project. There is no
    project-recovery route in v0.1.
27. **Protected deleted names.** Purge protection is one-way. A protected secret or
    certificate can never be purged, so its name remains reserved permanently even after
    retention. Recover it before retention or use a different name.
28. **Purge evidence window.** The destructive secret or certificate purge runs on a dedicated
    `openvault_purger` session, separate from the audit chain. A crash between the delete and
    its outcome event leaves the deletion without evidence. The allow decision is not written
    before the delete.
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
44. **Agent image.** The scaffold references
    `ghcr.io/blendsdk/openvault-agent:0.1.0`; image build, signing, and publishing are release
    engineering work. The snippet includes the host-directory preparation commands so the
    deployment contract is explicit before the image is published.
45. **Scaffold serialization.** Grant reconciliation and join-token rotation are serialized by a
    per-identity in-process mutex. This covers the single-instance v0.1 deployment. A
    multi-instance deployment would need a database advisory lock for the same guarantee.

46. **Native Windows CLI credentials.** The `ov` credential store fails closed with
    `credential_store_unsupported` on native Windows because Node cannot enforce an
    owner-only ACL without an external, untested command. WSL uses the POSIX path with
    `0700`/`0600` checks.
47. **Deferred CLI operations.** `ov backup`, `ov restore`, and `ov kek rotate` are registered
    and safety-gated, but the archive, restore, and KEK-rewrap operations belong to the backup
    and rotation release. They exit 1 with `not_implemented` and are not claimed as delivered.
48. **Bootstrap credential rotation.** The v0.1 bootstrap administrator is created with
    `must_change=false` because the CLI has no password-change route and the web UI is not yet
    available. The generated password is strong random material in a one-time `0600` file; the
    operator must remove that file after first use. Revisit when a CLI password-change route or
    the web UI lands.
49. **Generated contract schema source.** `pnpm api:check` detects route and artifact drift
    against the route metadata table. A controller schema change that leaves the table untouched
    is caught by the representative command end-to-end tests, not by `api:check` alone.
50. **Proxy and internal CA separation.** `ov login` and `ov doctor` trust the proxy's public
    root CA; the OpenVault internal CA signs the agent listener and the proxy-to-server
    upstream. Operators must keep the two files distinct. Using the wrong file produces a
    clear TLS verification failure, never a silent downgrade.
51. **CLI run manifest.** `ov run` uses a CLI-specific manifest profile rather than the agent
    manifest verbatim. It shares the entry grammar and safety bounds but omits agent-only
    fields such as `service`, `refresh`, and `output_dir`.
52. **Credential file at rest.** CLI tokens are stored in a `0600` JSON file until logout or
    expiry. Anyone who can read the file as the current user can use the session; the lock and
    permission checks protect against other users and concurrent processes, not a compromised
    account.
