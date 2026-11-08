# Deliver a secret to a Compose service

This tutorial adds an OpenVault agent to a Compose service, starts the service, and reads the
delivered secret from the service's tmpfs directory. It uses the reference stack as the vault
and a tiny Alpine container as the application.

## 1. Start the reference stack

From the repository root:

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time bootstrap password and sign in:

```bash
install -m 0600 /dev/null /tmp/openvault-bootstrap
docker compose -f deploy/compose/compose.yaml cp \
  openvault-init:/bootstrap/bootstrap-password /tmp/openvault-bootstrap
cat /tmp/openvault-bootstrap
rm -f /tmp/openvault-bootstrap
```

Open `https://localhost` and sign in as `admin@openvault.local`. Change the password before you
continue if this stack will live longer than the tutorial.

## 2. Create the project and secret

Build the CLI if you have not already:

```bash
pnpm install
pnpm --filter @openvault/cli build
export OPENVAULT_CA_FILE="$PWD/deploy/compose/data/ca/ca.pem"
node apps/cli/dist/main.js login --url https://localhost --identifier admin@openvault.local
```

The commands below use `ov`; substitute `node apps/cli/dist/main.js` if the binary is not on your
`PATH`.

```bash
ov project create tutorial
printf 'tutorial-value-1' | ov secret set api-token --project tutorial --stdin
```

The secret is encrypted at rest. The agent will receive only the value named in its manifest.

## 3. Scaffold the agent

```bash
ov docker scaffold tutorial api \
  --secret api-token \
  --compose-project tutorial \
  --out tutorial
```

The command writes two files and prints a one-time join token:

| File | Purpose |
|---|---|
| `tutorial/openvault.tutorial.api.compose.yaml` | Agent and application service snippet |
| `tutorial/openvault.tutorial.api.manifest.yaml` | The exact secret-to-file mapping |

Store the join token in a shell variable or an environment file outside the Compose file:

```bash
export OPENVAULT_JOIN_TOKEN='paste-the-token-here'
```

The token is shown once. Re-running the scaffold command rotates it.

## 4. Prepare the host paths

The agent and the application run as UID/GID `10001` and share a host tmpfs directory. Create
the directories before Compose starts; Docker would create missing bind sources as root.

```bash
export COMPOSE_PROJECT_NAME=tutorial
install -d -m 0700 -o 10001 -g 10001 \
  "/dev/shm/openvault/tutorial/${COMPOSE_PROJECT_NAME}/api" \
  "./tutorial/openvault-state/tutorial/${COMPOSE_PROJECT_NAME}/api"
install -m 0444 -o 10001 -g 10001 \
  "deploy/compose/data/ca/ca.pem" \
  "./tutorial/openvault-ca.pem"
```

The generated Compose file references `./openvault-ca.pem` and
`./openvault.tutorial.api.manifest.yaml` relative to the file's directory.

## 5. Add the application image

The generated `api` service has the volume and `depends_on` wiring but no image. Open
`tutorial/openvault.tutorial.api.compose.yaml` and add a tiny application image and command:

```yaml
services:
  api:
    image: alpine:3.21
    command: ["sh", "-c", "cat /run/secrets/api_token; sleep 3600"]
    # Keep the generated user, volumes, and depends_on below this block.
```

For the agent image, use the published release image or build it locally:

```bash
docker build -f deploy/docker/agent.Dockerfile -t openvault-agent:tutorial .
```

Then replace `ghcr.io/blendsdk/openvault-agent:0.1.0` in the generated file with
`openvault-agent:tutorial` if you built it locally.

The generated file ends with an external `vault_net`. The reference stack's network is named
after its Compose project, so add the real name:

```yaml
networks:
  vault_net:
    external: true
    name: openvault_vault_net
```

## 6. Start the service and read the file

```bash
docker compose -f tutorial/openvault.tutorial.api.compose.yaml up -d
docker compose -f tutorial/openvault.tutorial.api.compose.yaml ps
docker compose -f tutorial/openvault.tutorial.api.compose.yaml \
  exec api cat /run/secrets/api_token
```

You should see `tutorial-value-1`. The application never talks to the vault; the agent fetched
the value over mTLS and wrote the file.

Check the agent's status:

```bash
docker compose -f tutorial/openvault.tutorial.api.compose.yaml \
  exec openvault-agent-api ov-agent health --ready
```

Exit code `0` means every required manifest entry is present. A missing required entry makes
the agent remove its managed files and exit non-zero, so the application's `depends_on` health
gate stops it.

## 7. Rotate and verify

Write a new version:

```bash
printf 'tutorial-value-2' | ov secret set api-token --project tutorial --stdin
```

Restart the agent to fetch immediately, or wait for its refresh interval:

```bash
docker compose -f tutorial/openvault.tutorial.api.compose.yaml \
  restart openvault-agent-api
docker compose -f tutorial/openvault.tutorial.api.compose.yaml \
  exec api cat /run/secrets/api_token
```

The file now contains `tutorial-value-2`. The old version remains readable through the API until
it is deleted or purged; the file delivery always uses the newest active version.

## 8. Clean up

```bash
docker compose -f tutorial/openvault.tutorial.api.compose.yaml down --remove-orphans
rm -rf "/dev/shm/openvault/tutorial/${COMPOSE_PROJECT_NAME}"
rm -rf ./tutorial
```

The reference stack is separate; stop it with
`docker compose -f deploy/compose/compose.yaml down` when you are done.

## What you learned

- The scaffold command creates the identity, the least-privilege grant, the manifest, and a
  one-time token.
- The agent is the only bridge from the application network to the vault.
- The application reads an ordinary file from a per-service tmpfs directory.
- Rotation is a new immutable version; the agent refreshes it on its interval.

## Next

- [Agent](/guide/agent)
- [Docker Compose](/guide/docker-compose)
- [Rotation](/guide/rotation)
