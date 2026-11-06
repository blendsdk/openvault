# Findings Ledger: RD-14 Release Assurance

> **Status**: Active until merge
> **Last Updated**: 2026-11-06

| ID | Source | Finding | Resolution | Status |
|---|---|---|---|---|
| F-14-01 | Security review SEC-01 | Browser login could outlive a concurrent password change. | Session is created first, then the hash is re-read; a mismatch revokes the session. | Closed |
| F-14-02 | Correctness review ADR-01 | A file-backed DB URL did not reach startup migrations. | `runStartupMigrations` always supplies the explicit URL. | Closed |
| F-14-03 | Design challenge AC-01 | The broad proxy default exposed admin routes on typical Docker networks. | Default is loopback; the reference stack pins the proxy address. | Closed |
| F-14-04 | Design challenge AC-02 | KEK rotation could orphan a row written by a live server. | Rotation refuses while `openvault_app` is connected; KEK ids are random and never reused. Two rotations are tested. | Closed |
| F-14-05 | Security review SEC-04 / AC-03 | Restore verified a sample, not every encrypted value. | Preflight and post-restore verification cover every current secret, certificate private key, audit/CA/signing wrapped key, and a JWT sign/verify probe. | Closed |
| F-14-06 | Design challenge AC-10/AC-11/AC-14 | The release gate was not bound to a commit, images were tagged before scanning, and the parser mismatched the file format. | Gate requires the reviewed commit, release, reviewer, and zero open High/Critical; production dispatch must run from a tag; builds push a staging tag and promote only after scan/sign; parser has positive/negative self-tests. | Closed |
| F-14-07 | Correctness review ADR-02 / AC-12 | Runtime TLS did not verify the leaf signature or exact SANs. | Runtime and init verify the signature and use `checkHost`/`checkIP`; agent tests now issue a server leaf from the same CA they trust. | Closed |
| F-14-08 | Design challenge AC-13 | The incident runbook implied CA rotation that did not exist. | Runbook and limitations now state CA compromise requires a fresh deployment; no online rotation is claimed. | Closed |
| F-14-09 | Security review SEC-05 | Prune completion evidence can be lost after the delete. | Boundary checkpoint remains; an intent event is follow-up work. | Accepted |
| F-14-10 | Design challenge AC-04/AC-07/AC-08/AC-09 | Restore rollback freshness, renewal second factor, OIDC linking, and empty-chain trust are not fully solved. | Each is documented in `docs/security/limitations.md`; the claims ledger narrows the corresponding statements. | Accepted |
| F-14-11 | External review | The independent review is not performed. | Approval file is Pending; the release workflow refuses a production label. This is the one operator-provided gate. | Blocked on operator |

## Verification Evidence

- `pnpm verify`: passed (including evidence, claims, Compose, and release-gate self-tests).
- Evidence matrix: 20 threats, 14 required RD spec maps.
- Claims ledger: 17 claims, all implemented claims linked to executable evidence.
- PostgreSQL 16/17: 701 tests each.
- Branch protection verified through the GitHub API.
- Release workflow and scheduled scan parse as YAML; every action is SHA-pinned.
