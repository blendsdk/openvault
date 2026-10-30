# Deployment and Documentation: RD-02

> **Document**: 03-04-deployment-docs.md
> **Parent**: [Index](00-index.md)
> **CodeOps Artifact Schema**: 1

## Overview

This component aligns the reference deployment and documentation with the validated transport
boundary. It adds a dedicated admin network, pins the proxy source CIDR, supplies the required
CA/agent variables, moves HSTS and proxy timeouts to Caddy, and documents the actual readiness
and keyring contract.

The deployment target and network model are owned by RD-02 and
[RD-13](../../requirements/RD-13-backup-rotation-ops.md); this document records the RD-02
changes (AR-7, AR-16).

## Compose Topology

### Networks

| Network | Members | Purpose |
|---|---|---|
| `edge_net` | proxy | Public 80/443 |
| `admin_net` | proxy, openvaultd | Proxy-to-admin HTTPS only; dedicated subnet |
| `vault_net` | openvaultd, agents (future) | Agent mTLS and internal service traffic |
| `db_net` | openvaultd, PostgreSQL | Database only |

`admin_net` uses `172.30.0.0/24` with pinned addresses:

- proxy: `172.30.0.2`
- openvaultd: `172.30.0.3`

The proxy is removed from `vault_net`; it reaches the admin listener through `admin_net`.
Agents stay on `vault_net` and cannot pass the admin source guard. PostgreSQL stays on
`db_net` only. This is defense in depth; the application guard remains authoritative.

### Server environment

Add or update:

```yaml
OPENVAULT_ADMIN_PORT: "8443"
OPENVAULT_AGENT_PORT: "8444"
OPENVAULT_INTERNAL_CA: /etc/openvault/tls/ca.pem
OPENVAULT_TRUST_PROXY: "true"
OPENVAULT_PROXY_CIDRS: 172.30.0.2/32
OPENVAULT_LOG_LEVEL: info
```

Keep the existing `OPENVAULT_BASE_URL`, `OPENVAULT_DB_URL`, `OPENVAULT_KEYRING`,
`OPENVAULT_TLS_CERT`, and `OPENVAULT_TLS_KEY`. Do not publish `8443` or `8444` on the host.
Mount `openvault_tls` read-only at `/etc/openvault/tls` for the CA and server material.

Add a container healthcheck that probes the admin `/health` endpoint over TLS. It may use the
image's Node runtime and accept the internal server certificate only for this loopback probe;
the public contract remains proxy TLS. If the image has `wget`, the equivalent is:

```yaml
healthcheck:
  test: ["CMD-SHELL", "wget --no-check-certificate -qO- https://127.0.0.1:8443/health || exit 1"]
  interval: 10s
  timeout: 3s
  retries: 5
```

The exact helper is adjusted to the release image in RD-14; the important properties are
loopback source, `/health`, TLS, and no host port publication.

### Caddy

`deploy/compose/Caddyfile` keeps the upstream TLS connection to `openvaultd:8443` and adds:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` at the public edge;
- upstream `tls_trusted_ca_certs /etc/openvault/tls/ca.pem`;
- `read_timeout 30s`, `write_timeout 30s`, and `idle_timeout 120s` on the reverse proxy;
- no HSTS on plain HTTP before redirect;
- no `8443` listener.

The proxy certificate remains the public TLS trust anchor. The server certificate is separate
and is trusted by Caddy through the internal CA.

## Documentation

Update `docs/reference/configuration.md`:

- Keyring path is required, with mode `0600`.
- `OPENVAULT_ADMIN_PORT` is canonical; `PORT` is a compatibility alias; a conflict is an error.
- `OPENVAULT_AGENT_PORT` and `OPENVAULT_INTERNAL_CA` are required.
- `OPENVAULT_PROXY_CIDRS` is the only source allowed to set forwarded headers; the reference
  Compose uses a single proxy address.
- `OPENVAULT_KEYRING_PASSPHRASE_FILE` is reserved for RD-13; setting it in RD-02 fails closed.
- `/health` is liveness and `/ready` is dependency readiness; `/v1/ready` is not a contract.
- HSTS and public TLS timeouts are owned by Caddy.
- The keyring file shape remains the documented JSON; this plan does not add age support.

Update `deploy/compose/README.md` with the network table and the required environment. Add
`openssl` to the local development prerequisites in `CONTRIBUTING.md` for the transport test
fixtures.

## Security Properties

- No admin port is published to the host.
- The admin listener sees only the dedicated proxy network; the source guard rejects direct
  admin traffic from agents or database networks.
- The agent listener requires a client certificate from the internal CA.
- Caddy terminates public TLS, adds HSTS, and applies proxy timeouts.
- The server does not log configuration values or key material.
- The keyring and TLS material remain outside PostgreSQL.

## Integration Points

- 03-01 supplies required-path and mode validation.
- 03-02 supplies listener ports, proxy CIDRs, and TLS material.
- RD-13 owns backup/restore, age keyring encryption, certificate rotation, and the release
  image.
- RD-14 owns signed image, SBOM, scans, and independent transport verification.

## Testing Requirements

- ST-34 in [07-testing-strategy.md](07-testing-strategy.md) asserts the Compose network,
  required environment, no published `8443`, Caddy HSTS, and proxy timeouts.
- Documentation checks are part of `pnpm docs:build`; links resolve and the configuration page
  matches the implemented variable names.
- No test or documentation example includes a real secret, private key, or keyring value.
