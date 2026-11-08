# Tutorials

Short, end-to-end walkthroughs for the tasks people do first. Each tutorial uses a disposable
local environment and fake values; none of them is a production installation guide.

| Tutorial | What you will do | Time |
|---|---|---|
| [Your first secret](/tutorials/first-secret) | Start the review stack, create a project and secret, reveal it, and verify the audit event | 10 minutes |
| [Deliver a secret to a Compose service](/tutorials/compose-agent) | Scaffold an agent, write a manifest, start a service, and read the delivered file | 20 minutes |
| [Backup, restore, and KEK rotation drill](/tutorials/backup-restore-drill) | Take an encrypted backup, restore into a clean target, and rotate the KEK | 30 minutes |

## Before you start

- Docker with Compose v2.24 or newer.
- Node.js 24.7+ and pnpm 12.18.0 if you run the CLI or build images from source.
- About 4 GB of free disk space for the review stack.

The tutorials use only the shipped `deploy/compose/` files and the public CLI. Read
[Install](/guide/install) before you point any of this at a real host.

::: warning Not production
The review stack and its bootstrap password are for local evaluation. Use the production
installation flow in [Docker Compose](/guide/docker-compose) for real workloads.
:::

## Clean up

The first tutorial uses the disposable review stack:

```bash
./deploy/compose/review.sh down
```

The other tutorials use a separate Compose project. Tear it down with the `down` command shown
at the end of each tutorial, then remove the host directories it created.
