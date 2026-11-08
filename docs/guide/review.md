# Review the app

This page sets up a disposable local OpenVault stack with synthetic data so you can review the
product without a production host, a public domain, or real secrets.

::: warning Not a production deployment
This environment uses Caddy's local CA, a one-time bootstrap password, and fake data. It is for
product review only. It is not the independent security review described in
[Independent review](/security/external-review), and it does not approve a production image.
:::

## What the environment gives you

`deploy/compose/review.sh` builds the current checkout, prepares host directories and Docker
secrets without requiring `sudo`, starts the full reference stack on `127.0.0.1`, and seeds
three projects, secrets, certificates, identities, grants, and audit events.

Only the proxy is reachable from the host, on `https://localhost:8443`. The API, agent, web,
and PostgreSQL listeners remain on internal Docker networks.

## Quick start

Requirements: Docker with Compose v2.24 or newer, `curl`, and about 4 GB of free disk space.
The first run builds the server and web images and can take several minutes.

```bash
./deploy/compose/review.sh up
./deploy/compose/review.sh password
```

After changing application code, rebuild with `./deploy/compose/review.sh up --build`.
Open `https://localhost:8443` and sign in as:

| Field | Value |
|---|---|
| Email | `admin@openvault.local` |
| Password | The value printed by `review.sh password` |

The first visit shows a certificate warning because Caddy uses a local CA. In Chrome choose
**Advanced → Proceed to localhost (unsafe)**; in Firefox choose **Advanced → Accept the Risk and
Continue**. To inspect the CA or import it, run:

```bash
./deploy/compose/review.sh ca
```

If port `8443` is already in use, pick another loopback port:

```bash
OPENVAULT_REVIEW_PORT=9443 ./deploy/compose/review.sh up
```

## What is seeded

| Project | Secrets | Certificate | Identity and grant |
|---|---|---|---|
| `payments` | `stripe-api-key` (two versions), `database-url` | `payments-api`, 30 days | `payments-api`, object-scope `secrets.reader` on both secrets |
| `analytics` | `warehouse-api-key` | `analytics-api`, 14 days | `analytics-worker`, project-scope `secrets.reader` |
| `platform` | `smtp-password` | `deploy-bot`, 90 days | `deploy-bot`, project-scope `certificates.reader` |

Every value is fake and safe to reveal. The seed is idempotent; `review.sh seed` repairs a
partially seeded stack without creating duplicate projects, identities, or grants.

## Review walkthrough

### Projects and secrets

1. Open **Projects**. You should see three projects and one certificate each.
2. Open **payments → Secrets**, then open `stripe-api-key`.
3. Reveal the value. The value is audited; confirm the event in the project's **Audit** page.
4. Open **Versions** to see the rotation history and **Tags** to see `env=review`.
5. Change the value, then confirm that a new version appears and the old version remains.

### Identities and permissions

1. Open **payments → Identities**. `payments-api` is a service identity, not a human user.
2. Open **payments → Permissions**. The object-scope grant limits the identity to the two named
   secrets.
3. Use the CLI to see the effective policy:

```bash
./deploy/compose/review.sh cli
# inside the shell:
ov access explain stripe-api-key --project payments --target-type secret
```

Closing the shell discards its temporary CLI credentials. The shell signs in with the bootstrap
password. If you already changed that password, it opens without a session and prints the
`ov auth login` command to use.

### Audit

1. Open **payments → Audit**.
2. Filter by `secret.read` and confirm that the reveal you performed is present.
3. Run the chain check from the CLI:

```bash
./deploy/compose/review.sh cli
# inside the shell:
ov audit verify
```

The audit page and CLI never show secret values or private keys.

### Certificates

The web UI currently shows certificate counts but does not have a certificate management page.
Use the signed-in CLI shell:

```bash
./deploy/compose/review.sh cli
# inside the shell:
ov cert list --project payments
ov cert list --project analytics
ov cert get payments-api --project payments
```

The `analytics-api` certificate is deliberately short-lived so the expiry columns are useful.
Private-key reads require `--out` and write the key with mode `0600`; the key is never printed.

## Browser security checks

These checks take a minute and are worth doing during a product review:

1. Open DevTools → **Application → Storage**. There should be no secret values in local storage,
   session storage, IndexedDB, or JavaScript-readable cookies.
2. Open DevTools → **Application → Cookies**. The session cookie is named `__Host-ov_session`,
   is `HttpOnly`, `Secure`, and `SameSite=Lax`.
3. Reveal a secret while DevTools → **Network** is open. The value arrives in the response body
   of an authenticated request; it is not persisted to browser storage.
4. Sign out and sign back in. The sign-out should clear the session cookie and return the old tab
   to the login page on its next request.

## Change the bootstrap password

The synthetic environment is disposable, but the password is still a real credential. After the
first sign-in, change it in the UI and remove both host copies:

```bash
./deploy/compose/review.sh forget-password
```

The current password is unchanged; only the one-time files are removed. `review.sh cli` then
opens an unsigned shell and prints the `ov auth login` command.

## Stop, keep, or reset

| Command | Result |
|---|---|
| `./deploy/compose/review.sh down` | Stop containers; keep the database, keyring, and generated CA |
| `./deploy/compose/review.sh up` | Start the existing environment again |
| `./deploy/compose/review.sh forget-password` | Remove both host copies of the bootstrap password |
| `./deploy/compose/review.sh reset` | Delete the review database, keyring, CA, and Docker secrets |
| `./deploy/compose/review.sh reset --yes` | Reset without the confirmation prompt |

The review stack never writes to production paths. `reset` refuses to delete a custom
`OPENVAULT_DATA_DIR` or `OPENVAULT_SECRETS_DIR`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port 8443 is already in use` | Set `OPENVAULT_REVIEW_PORT` to another loopback port |
| `cannot reach the Docker daemon` | Start Docker and confirm your user can run `docker ps` |
| Certificate warning | Expected with the local CA; use **Advanced** or import `review.sh ca` |
| Stack does not become ready | Run `./deploy/compose/review.sh logs` |
| Seed fails after a password change | The bootstrap password no longer works; run `review.sh reset` for a fresh stack |
| Password file was removed | It is one-time; if you did not save the password, reset the environment |

## Independent security review

Product acceptance and the independent security review are separate. The Codex review covers
cryptographic design, authentication and sessions, agent isolation, and deployment. Its status
is recorded in `docs/security/external-review.md` and is currently **Pending**. No
production-labelled image may be published until that review is approved.
