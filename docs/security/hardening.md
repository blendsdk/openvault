# Hardening checklist

Use this before putting OpenVault in front of real workloads.

## Host

- [ ] Docker and the host are patched.
- [ ] Swap is disabled or encrypted.
- [ ] `/dev/shm/openvault` is on tmpfs and mode `0700`.
- [ ] The host is not shared with untrusted users.
- [ ] Backups are encrypted and stored off-box.
- [ ] NTP is configured; certificate and token validation depend on correct time.

## Network

- [ ] The server is not attached to application networks.
- [ ] Only the proxy exposes port 443.
- [ ] Admin `8443` is on `admin_net` only and is not published.
- [ ] Agent `8444` is on `vault_net` only and is not published.
- [ ] PostgreSQL is on `db_net` only.
- [ ] Agents are the only containers on both `vault_net` and an app network.
- [ ] No Docker socket is mounted into any container.
- [ ] `OPENVAULT_TRUST_PROXY` is true only behind the proxy.
- [ ] `OPENVAULT_PROXY_CIDRS` is pinned to the proxy address, not the broad default.

## TLS and certificates

- [ ] The proxy uses a trusted certificate.
- [ ] The server certificate and key match; the internal CA has `CA:TRUE`.
- [ ] The agent trusts only the expected server CA.
- [ ] Workload certificates are short-lived and renewed.
- [ ] Revoked identities are removed from service.
- [ ] Certificate expiry alerts reach a real channel.
- [ ] The keyring file is mode `0600`; age encryption is unavailable until RD-13.

## Identity

- [ ] The bootstrap password was changed.
- [ ] OIDC, if used, enforces MFA at the provider.
- [ ] JIT provisioning is disabled or limited to allowed domains.
- [ ] The last organization administrator is documented.
- [ ] CLI credentials are mode `0600`.

## Access control

- [ ] No service identity holds control-plane actions.
- [ ] No `org.admin` assignment exists for CI or automation.
- [ ] Project assignments are used instead of org-wide grants.
- [ ] Object-scope assignments are limited to readers.
- [ ] Temporary access has an expiry.

## Audit

- [ ] Audit verification passes.
- [ ] Checkpoints are exported off-box on a schedule.
- [ ] Denials are reviewed.
- [ ] Retention matches policy.
- [ ] Backups include the audit chain.

## Operations

- [ ] A restore drill succeeded.
- [ ] KEK rotation was tested.
- [ ] The keyring is backed up separately.
- [ ] `ov init` provisioned the keyring and TLS material (RD-11/RD-13).
- [ ] Monitoring alerts on `/ready`, agent health, and certificate expiry.
- [ ] The threat model and limitations were reviewed.
