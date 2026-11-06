# Purge Evidence: Security Findings Remediation

> **Document**: 03-05-purge-evidence.md
> **Parent**: [Index](00-index.md)

## Overview

Write the actor-attributed authorization event before the destructive purge transaction, then write a completion event after a successful delete. A crash or audit outage after the delete cannot remove the only evidence.

## Event Contract

| Phase | When | Result | Meaning |
|---|---|---|---|
| `authorized` | Before `deleteSecret`/`deleteCertificate` | `allow` | The actor was authorized; the delete is about to run |
| `completed` | After a successful delete | `allow` | The delete committed |
| `failed` | After a delete failure | `error` | The delete did not complete |

A request may produce `authorized` + `completed`, or `authorized` + `failed`. It never produces only `completed`.

## Secret Purge

1. Resolve and authorize.
2. Validate deleted state, protection, and retention.
3. Resolve the purger (or fail 503).
4. Write the allow decision with `details: { phase: "authorized" }` before `purger.deleteSecret`.
5. Delete.
6. On delete failure, write the existing error event and throw.
7. On success, write the allow decision with `details: { phase: "completed" }`.
8. If the completion write fails, throw `PolicyUnavailableError` (503). The `authorized` event remains.

## Certificate Purge

Same order at `apps/server/src/certificates/lifecycle.ts:365-419`.

## Failure Behavior

- Pre-delete audit failure: no delete; 503.
- Delete failure: existing error event; 409/503 as today.
- Delete failure + error-event failure: `authorized` remains, no `failed`; 503. Document that the absence of a completion event means “unknown,” not “success.”
- Crash after delete but before completion: `authorized` remains; no `completed`; the operator sees an unknown outcome, not a silent deletion.
- Crash before delete: `authorized` remains; no `completed`; safe.

## Limitation Update

Update `docs/security/limitations.md` item 28:

- The authorization event is durable before the delete.
- A completion event is written after a successful delete.
- A crash or audit outage can leave `authorized` without `completed`; that means the outcome is unknown, not that the purge definitely succeeded.
- The allow event no longer disappears because the delete committed first.

Also update `docs/guide/secrets.md` and `docs/guide/certificates.md` where they describe the old window.

## Tests

`apps/server/tests/integration/purge.spec.test.ts`:

- ST-20: pre-delete audit failure → 503; secret exists; no delete.
- ST-21: first audit write succeeds, second throws → secret deleted; `authorized` event exists; `completed` absent; 503.
- ST-22: certificate path same.
- ST-22b: delete failure → `authorized` + `failed`.
- ST-22c: exact event count and phases; no duplicate allow with the same phase.

The existing exact-one-allow assertion in `apps/server/tests/integration/secrets-lifecycle.spec.test.ts:223-226` must change to expect the two phases.

## Acceptance

See `07-testing-strategy.md` ST-20…ST-22c and `01-requirements.md` R5.
