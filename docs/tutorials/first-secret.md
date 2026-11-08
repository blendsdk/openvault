# Your first secret in 10 minutes

This tutorial starts the disposable review stack, creates a project and secret, reveals the
value once, and verifies that the read was written to the audit chain. Use only the fake values
the review stack provides.

## 1. Start the review stack

Requirements: Docker Compose v2.24+ and about 4 GB of free disk space. The first run builds the
server and web images, so it can take several minutes.

```bash
./deploy/compose/review.sh up
./deploy/compose/review.sh password
```

The second command prints the one-time password for `admin@openvault.local`. Keep it in the
terminal; do not put it in a file inside the repository.

Open `https://localhost:8443` and sign in. The first visit shows a certificate warning because
Caddy uses a local CA. Choose **Advanced → Proceed to localhost (unsafe)** in Chrome, or
**Advanced → Accept the Risk and Continue** in Firefox.

::: tip Change the bootstrap password
The review stack is disposable, but changing the password is still good practice. Use the
account menu after sign-in; the change is audited.
:::

## 2. Create a project in the UI

1. Open **Projects** and choose **Create project**.
2. Name it `tutorial` and save.
3. Open `tutorial → Secrets` and create a secret named `demo-token`.
4. Enter a fake value such as `tutorial-value-1` and save.

The value is encrypted before it reaches the database. The list shows only metadata; the value is
returned only when you explicitly reveal it.

## 3. Reveal the value and check the audit trail

1. Open `demo-token` and choose **Reveal**.
2. Confirm the value is `tutorial-value-1`.
3. Open `tutorial → Audit` and filter by `secret.read`.

You should see one event for your reveal. The audit page never shows the value itself. The
audit chain is HMAC-protected and hash-linked; the next tutorial shows how to verify it from the
CLI.

## 4. Repeat the flow from the CLI

The review shell signs in with the bootstrap password and gives you a temporary credential
file. It removes the file when you close the shell.

```bash
./deploy/compose/review.sh cli
```

Inside the shell:

```bash
ov project list
ov project create tutorial
printf 'tutorial-value-2' | ov secret set demo-token --project tutorial --stdin
ov secret get demo-token --project tutorial
ov secret versions demo-token --project tutorial
ov audit verify
```

Expected results:

- `project list` includes the seeded projects and, after you create it, `tutorial`.
- `secret get` prints only the value, never the metadata.
- `secret versions` shows the new version and the previous version.
- `audit verify` reports that the chain is intact.

If the project or secret already exists from the UI steps, skip the create command. Re-running
`ov secret set` writes a new immutable version; that is the intended rotation behavior.

## 5. Stop the stack

```bash
./deploy/compose/review.sh down
```

Use `./deploy/compose/review.sh reset` if you want to delete the review data and start from a
clean state. The reset is explicit and guarded; it never touches a non-review deployment.

## What you learned

- A project is the namespace for secrets, certificates, identities, and grants.
- Every write creates an immutable version.
- Every reveal is an audited read; the value is not stored in the browser.
- The CLI uses the same API and the same audit rules as the UI.

## Next

- [Deliver a secret to a Compose service](/tutorials/compose-agent)
- [Projects and secrets](/guide/secrets)
- [Audit](/guide/audit)
