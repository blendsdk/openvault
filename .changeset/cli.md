---
"@openvault/cli": minor
"@openvault/api-contract": minor
"@openvault/server": minor
---

Add the `ov` CLI, the generated CLI API contract, and the shared bootstrap command.

The CLI provides bootstrap, authentication, project and secret management, certificates,
identities, roles, access explanation, audit query/verify/export, Docker scaffold, and
`run --` secret delivery. Tokens live in a protected credential file with atomic writes and a
cross-process lock; native Windows fails closed.

`apps/server/scripts/api-contract.ts` builds `packages/api-contract/openapi.json` and the typed
client in `apps/cli/src/generated` from the real controllers. `pnpm api:check` fails on drift
and runs inside `pnpm verify`.

`ov init` creates or reuses the keyring, internal CA, server certificate, organization,
bootstrap administrator, and signing key. It is idempotent, never rotates the CA, guards against
a missing keyring with existing wrapped state, and writes a generated password only to a
one-time `0600` file.

`ov backup` and `ov restore` create and verify passphrase-encrypted age archives containing a
logical database dump, keyring, redacted config, public CA, and audit checkpoints. `ov kek
rotate` rewraps every stored key without re-encrypting values and removes the old key only
after full verification.

The remaining RD-13 operations (secret/certificate rotation workflows, Compose hardening,
least-privilege role provisioning, and release engineering) are still owned by RD-13.
