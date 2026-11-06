---
"@openvault/agent": minor
"@openvault/api-contract": minor
"@openvault/cli": minor
"@openvault/core": minor
"@openvault/server": minor
"@openvault/web": minor
---

Add the operations, deployment, and release-assurance layer.

- Restore can verify a pre-backup agent certificate and now decrypt-checks every current
  secret, certificate private key, audit key, CA key, and JWT seed before reporting success.
- File-backed database URLs, a separate startup migrator URL, and a startup migration switch
  let the runtime connect as `openvault_app` while an init job owns DDL.
- The reference Compose stack gains a static web container, Docker secrets, non-root users,
  read-only roots, capability drops, resource limits, log rotation, internal networks, and a
  scripted hardening contract.
- PostgreSQL role provisioning separates migrator, runtime, purge, and prune privileges.
- `ov doctor` checks the database, keyring, TLS, clock, and 24-hour backup age.
- `ov audit checkpoint` exports the audit anchor for scheduled off-box retention.
- The threat-model evidence matrix, security claims ledger, incident runbook, release
  workflow, SBOM, Trivy gate, Cosign signing, provenance, and weekly rescan make release
  evidence reproducible. A production label is blocked until the external review is approved.
