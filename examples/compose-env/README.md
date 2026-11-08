# Deliver secrets as environment variables

This example shows the recommended way to give a Compose application OpenVault
secrets as environment variables at startup. A per-service agent writes the
secret to a private tmpfs, and a small loader in the application container
exports it before the application starts.

The application never talks to the vault. The agent is the only bridge.

## Files

| File | Purpose |
|---|---|
| `compose.yaml` | The agent sidecar and the application service |
| `manifest.yaml` | The one secret the agent may fetch |
| `env.map` | Environment variable name to secret file name |
| `loader.sh` | Reads the files, exports the variables, then execs the application |
| `.env.example` | The one-time join token and Compose project name |
| `run.sh` | Prepares host paths and starts the example |

## 1. Start OpenVault

From the repository root:

```bash
./deploy/compose/prepare.sh
export OPENVAULT_BASE_URL=https://localhost
export OPENVAULT_SITE_ADDRESS=localhost
docker compose -f deploy/compose/compose.yaml up -d
```

Read the one-time bootstrap password and sign in at `https://localhost` as
`admin@openvault.local`. See
[Docker Compose](https://blendsdk.github.io/openvault/guide/docker-compose#bootstrap-password)
for the exact password-copy command.

## 2. Create the project and secret

Using the CLI:

```bash
export OPENVAULT_CA_FILE="$PWD/deploy/compose/data/ca/ca.pem"
node apps/cli/dist/main.js login --url https://localhost --identifier admin@openvault.local
node apps/cli/dist/main.js project create quickstart
printf 'example-value' | node apps/cli/dist/main.js secret set api-token --project quickstart --stdin
```

The value is encrypted at rest. The agent receives only `api-token`.

## 3. Create the service identity and join token

The scaffold command creates the service identity, grants object-scope read on
`api-token`, and prints a one-time join token:

```bash
node apps/cli/dist/main.js docker scaffold quickstart api \
  --secret api-token \
  --compose-project compose-env \
  --out .scaffold
```

The `.scaffold` directory is a generated reference. This example uses the
checked-in `manifest.yaml` and `compose.yaml` instead, so the wiring stays
readable.

Copy `.env.example` to `.env` and paste the token:

```bash
cp .env.example .env
# edit .env: OPENVAULT_JOIN_TOKEN=<the token printed by the scaffold command>
chmod 0600 .env
```

Never commit `.env`. The token is shown once; re-running the scaffold command
rotates it.

## 4. Start the example

```bash
./run.sh
```

The script creates the agent's host directories, copies the public CA into the
example, starts the agent and the app, and waits for:

```text
APP_API_TOKEN is set in the api container.
```

The application sees the secret as an environment variable. Check it without
printing the value:

```bash
docker compose exec api sh -c 'test -n "$APP_API_TOKEN" && echo set'
```

## 5. Rotate the secret

```bash
printf 'example-value-2' | node apps/cli/dist/main.js secret set api-token \
  --project quickstart --stdin
docker compose restart openvault-agent-api
docker compose restart api
```

The agent refreshes the tmpfs file. The loader runs only when the application
container starts, so restart the application to pick up the new value. Dynamic
reload is application-specific and outside this example.

## 6. Clean up

```bash
docker compose down --remove-orphans
rm -rf .scaffold .env openvault-ca.pem openvault-state
rm -rf "/dev/shm/openvault/quickstart/${COMPOSE_PROJECT_NAME}"
```

The reference stack is separate. Stop it with
`docker compose -f deploy/compose/compose.yaml down` when you are done.

## Why a loader

The sidecar agent runs in its own container, so its environment cannot reach
the application container. The agent writes files to a shared tmpfs; the loader
turns those files into environment variables inside the application container.

Environment-variable injection is for single-line values. Use file delivery for
binary or multi-line secrets. A distroless application that cannot run a shell
loader can use the agent's wrapper mode instead; see
[Environment variables](https://blendsdk.github.io/openvault/guide/environment-variables).
