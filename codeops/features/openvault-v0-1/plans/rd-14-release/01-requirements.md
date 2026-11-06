# RD-14 Requirements Delta

This plan implements the RD-14 Must Haves and the two Should Haves that fit the release
pipeline. The full requirement remains
[RD-14-security-release.md](../../requirements/RD-14-security-release.md).

## Evidence Already in the Repository

| Control | Existing evidence |
|---|---|
| Authorization matrix | `apps/server/tests/integration/rbac-policy.spec.test.ts`, `rbac-release.spec.test.ts` |
| Crypto and envelope | `apps/server/tests/integration/secrets-crypto.spec.test.ts`, `certificates-pem.spec.test.ts`, `keyring.spec.test.ts` |
| Auth and CSRF | `apps/server/tests/auth/*.spec.test.ts`, `apps/server/tests/integration/auth.*.test.ts` |
| Token reuse | `apps/server/tests/integration/auth.cli-refresh.spec.test.ts` |
| Agent mTLS | `apps/server/tests/integration/agent-*.spec.test.ts` |
| Audit tamper | `apps/server/tests/integration/audit-chain.spec.test.ts`, `audit-security.spec.test.ts`, `audit-verify.spec.test.ts` |
| Redaction and no-value leakage | `apps/server/tests/logging.spec.test.ts`, `apps/server/tests/integration/agent-logging.spec.test.ts`, web leak tests |
| Tmpfs isolation | `apps/agent/tests/*.spec.test.ts` |
| Deployment and readiness | `apps/server/tests/integration/readiness.spec.test.ts`, `transport.spec.test.ts` |
| Supply chain | `.github/workflows/*.yml` use full commit SHAs |

## Delivered by This Plan

| Requirement | Planned change |
|---|---|
| Threat-model-to-test matrix | JSON ledger, generated Markdown page, checker in `verify` |
| Every security-sensitive RD has a spec test | Required-spec map in the ledger and checker |
| Security tests cover the named categories | Matrix rows and checker coverage |
| Security-auditor and design-challenger gates | Stored review reports under the plan |
| Independent external review | Packet plus fail-closed approval file; production label blocked until approved |
| Signed amd64 image | Release workflow with Buildx, Cosign keyless, SBOM, provenance |
| SBOM and provenance | BuildKit attestations plus Syft SPDX release asset |
| Trivy scan at release and on schedule | Release job and weekly rescan workflow |
| SHA-pinned actions and least privilege | New workflows follow the existing pattern |
| Branch protection | Verified and recorded; no change required |
| Docs-accuracy gate | Claims ledger plus checker |
| Incident runbook | New security page |
| No production image before gates | External-review check before login, push, sign, or release |

## Explicitly Deferred

- Multi-arch images.
- A real external reviewer engagement (operator-provided).
- Playwright browser automation (release-candidate manual check).
- SOC 2, ISO 27001, and a bug bounty program.
