# Install

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
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://vault.example.com
export OPENVAULT_SITE_ADDRESS=vault.example.com
docker compose -f deploy/compose/compose.yaml up -d
```

`prepare.sh` creates the persistent host directories and Docker secrets with the
non-root owners the containers require. It needs root or equivalent permission once.
It never overwrites an existing secret.

The stack runs:

| Service | Purpose |
|---|---|
| `proxy` | Public TLS, HSTS, API/UI routing |
| `openvaultd` | API, auth, policy, audit, agent listener |
| `web` | Static SPA |
| `postgres` | Metadata, ciphertext, audit chain |
| `openvault-init` | One-shot keyring, CA, TLS, organization, bootstrap admin |
| `openvault-roles` | One-shot least-privilege database grants |

Only the proxy publishes port 443. The admin listener (`8443`) and agent listener
(`8444`) stay on internal networks. Replace the `tls internal` certificate with a
trusted certificate for anything beyond local use.

## First initialization

The Compose stack runs `ov init --prepare` automatically. For a manual install:

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
to a file with mode `0600`; it is never printed to stdout, stderr, or container logs. Sign in
through the web UI, change the password, then delete the one-time file. If the file is lost
before the first login, start again with an empty database.

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

## Verify a release image

Production images are signed with Cosign keyless and carry SBOM and provenance
attestations. Alpha images are explicitly labelled not for production.

```bash
IMAGE=ghcr.io/blendsdk/openvault@sha256:<digest>
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github.com/blendsdk/openvault/.github/workflows/release.yml@refs/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

docker buildx imagetools inspect "$IMAGE"
```

Use the digest from the GitHub release, not a floating tag. The same procedure applies to
`openvault-agent` and `openvault-web`. See [Release process](/security/release-process).

## Ports and networks

| Port | Listener | Exposure |
|---|---|---|
| 443 | Caddy public TLS | Host |
| 8443 | Admin HTTPS | `admin_net` only; not published |
| 8444 | Agent TLS (token join + mTLS) | `vault_net` only; not published |
| 8080 | Static web | `web_net` only; not published |
| 5432 | PostgreSQL | `db_net` only; not published |

The proxy reaches the admin listener on `admin_net`. Agents use the separate listener on
`vault_net`; the first join is token-authenticated, and every later agent request uses mTLS.
Agents never use the admin port. Application containers must not join
`admin_net`, `vault_net`, or `db_net`.

## Next

- [Docker Compose](/guide/docker-compose)
- [Operations](/guide/operations)
- [Authentication](/guide/authentication)
