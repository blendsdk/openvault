# Install

::: warning Target documentation
The Compose stack and `ov init` are part of the v0.1 target. The developer install works
today.
:::

## Requirements

| Component | Version |
|---|---|
| Node.js | 24.7 or newer |
| pnpm | 12.11.2 |
| Docker | Current stable |
| Docker Compose | v2 |
| PostgreSQL | 16 or 17, when running without the reference stack |

## Developer install

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
corepack enable
pnpm install
pnpm verify
```

## Reference Compose installation

```bash
cp .env.example .env
docker compose -f deploy/compose/compose.yaml up -d
```

The reference stack contains:

| Service | Purpose |
|---|---|
| `proxy` | TLS termination and HSTS |
| `openvaultd` | WebAFX API, UI, auth, policy, audit |
| `postgres` | Metadata, ciphertext, audit chain |

The vault UI is served at `https://localhost` in the reference stack. Replace the
self-signed certificate with a trusted one for anything beyond local use.

## First initialization

```bash
ov init
```

This creates:

- the organization and bootstrap administrator
- the KEK keyring file
- the internal CA for workload certificates
- the server certificate signed by the internal CA
- the JWT signing key, wrapped by the KEK

The bootstrap password is printed once. The first login forces a change.

`ov init` and the reference image are v0.1 deliverables. Until the provisioner lands, the
reference stack cannot create the required keyring or TLS material; use fixtures for local
transport tests.

::: danger Protect the keyring
The keyring is outside PostgreSQL and is the only way to decrypt stored values. Back it up
separately from the database, with mode `0600`. Losing it means losing every secret.
:::

Age-encrypted keyrings are not supported in the current release. Setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` stops startup rather than falling back to plaintext.

## Ports and networks

| Port | Listener | Exposure |
|---|---|---|
| 80 | Caddy HTTP redirect / ACME | Host |
| 443 | Caddy public TLS | Host |
| 8443 | Admin HTTPS | `admin_net` only; not published |
| 8444 | Agent mTLS | `vault_net` only; not published |
| 5432 | PostgreSQL | `db_net` only |

The proxy reaches the admin listener on `admin_net`. Agents use the separate mTLS listener
on `vault_net`; they never use the admin port. Application containers must not join
`admin_net`, `vault_net`, or `db_net`.

## Next

- [Docker Compose](/guide/docker-compose)
- [Authentication](/guide/authentication)
