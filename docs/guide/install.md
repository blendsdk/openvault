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
- the internal CA for workload certificates: the public certificate at
  `OPENVAULT_INTERNAL_CA` and the private key wrapped in `ca_keys`
- the server certificate signed by the internal CA
- the JWT signing key, wrapped by the KEK

Re-running `ov init` does not rotate an existing CA. The bootstrap password is written once
to a file with mode `0600`; it is never printed to stdout, stderr, or container logs. Unlike
the browser flow, the v0.1 bootstrap credential is not force-changed because the CLI has no
password-change route and the web UI is not yet available. Use the password, then delete the
one-time file.

`ov init` creates the keyring and TLS material used by the reference stack. The keyring and
password directories must be owned by the current user and must not be group- or
world-writable; mode `0700` is used when init creates them.

::: danger Protect the keyring
The keyring is outside PostgreSQL and is the only way to decrypt stored values. Back it up
separately from the database, with mode `0600` and a parent directory that is not group- or
world-writable. Losing it means losing every secret.
:::

Age-encrypted keyrings are not supported in the current release. Setting
`OPENVAULT_KEYRING_PASSPHRASE_FILE` stops startup rather than falling back to plaintext.

## Ports and networks

| Port | Listener | Exposure |
|---|---|---|
| 80 | Caddy HTTP redirect / ACME | Host |
| 443 | Caddy public TLS | Host |
| 8443 | Admin HTTPS | `admin_net` only; not published |
| 8444 | Agent TLS (token join + mTLS) | `vault_net` only; not published |
| 5432 | PostgreSQL | `db_net` only |

The proxy reaches the admin listener on `admin_net`. Agents use the separate listener on
`vault_net`; the first join is token-authenticated, and every later agent request uses mTLS.
Agents never use the admin port. Application containers must not join
`admin_net`, `vault_net`, or `db_net`.

## Next

- [Docker Compose](/guide/docker-compose)
- [Authentication](/guide/authentication)
