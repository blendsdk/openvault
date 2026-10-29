# Install

::: warning Target documentation
The Compose stack and `ov init` are part of the v0.1 target. The developer install works
today.
:::

## Requirements

| Component | Version |
|---|---|
| Node.js | 22.23 or newer |
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
- the JWT signing key, wrapped by the KEK

The bootstrap password is printed once. The first login forces a change.

::: danger Protect the keyring
The keyring is outside PostgreSQL and is the only way to decrypt stored values. Back it up
separately from the database, with mode `0600`. Losing it means losing every secret.
:::

## Ports and networks

| Port | Exposure |
|---|---|
| 443 | Proxy, public |
| 8443 | Server, internal `vault_net` only |
| 5432 | PostgreSQL, internal `db_net` only |

Application containers must not join `vault_net`.

## Next

- [Docker Compose](/guide/docker-compose)
- [Authentication](/guide/authentication)
