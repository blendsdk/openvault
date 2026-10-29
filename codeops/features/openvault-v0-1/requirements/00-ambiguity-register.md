# Ambiguity Register: openvault-v0-1

> **Status**: ✅ GATE PASSED — all 30 items resolved
> **Last Updated**: 2026-10-29 15:05

| # | Category | Ambiguity / Gap | Options Presented | User Decision | Status |
|---|----------|-----------------|-------------------|---------------|--------|
| AR-1 | Scope | Feature boundary: one release feature or split into platform/delivery/UI | One `openvault-v0-1` / split | User accepted the one-feature recommendation | ✅ Resolved |
| AR-2 | Technical | Transport model for browser/admin and agent traffic | Split admin listener + agent mTLS listener / single listener / network isolation only | User accepted split listeners | ✅ Resolved |
| AR-3 | Technical | Crypto foundation | Keep AES-GCM primitive, rewrite keyring/AAD API / full rewrite | User accepted keep-primitive | ✅ Resolved |
| AR-4 | Technical | Server security spine | Rebuild security spine / harden scaffold | User accepted rebuild | ✅ Resolved |
| AR-5 | Scope | Repository visibility and release posture | Public source + private advisories + no image until gates / private repo / public image now | User accepted public source, no image until gates | ✅ Resolved |
| AR-6 | Scope | v0.1 feature set | Accept the discovery in/out list | User accepted the in/out list | ✅ Resolved |
| AR-7 | Technical | External independent security review before v0.1 | Scoped external review at release candidate / full review / none / alpha-only fallback | User: "best possible option"; recorded as scoped external review at release candidate | ✅ Resolved |
| AR-8 | Data & state | Empty secret value behavior | Reject empty at API; crypto supports empty ciphertext / allow empty values | User accepted: reject empty at API | ✅ Resolved |
| AR-9 | Data & state | Binary secret support | Base64 with explicit encoding / UTF-8 only | User accepted: base64 with explicit encoding | ✅ Resolved |
| AR-10 | Data & state | Soft-delete and audit retention defaults | 30 days / 180 days / other | User accepted: 30 days soft delete, 180 days audit | ✅ Resolved |
| AR-11 | Non-functional | Backup RPO and RTO | 24 h / 1 h / other | User accepted: RPO 24 h, RTO 1 h | ✅ Resolved |
| AR-12 | Technical | Browser session store in v0.1 | In-memory / Postgres adapter / Redis | User accepted: in-memory in v0.1, Redis v0.2 | ✅ Resolved |
| AR-13 | Security | Break-glass recovery model | Offline keyring recovery / second admin bypass / none | User accepted: documented offline keyring recovery | ✅ Resolved |
| AR-14 | Security | Rate limits | 5/min login per IP, 10/h per account, 10/min join, 600/min data / other | User accepted the stated limits | ✅ Resolved |
| AR-15 | Security | Argon2id parameters | 64 MiB, 3 iterations, 1 lane / other | User accepted 64 MiB / 3 / 1 | ✅ Resolved |
| AR-16 | Data & state | OpenVault project vs Compose project mapping | Namespace + consumer label / one-to-one | User accepted: namespace + consumer label | ✅ Resolved |
| AR-17 | Security | Reviewer agent safety | Read-only bash allowlist, pinned installer / current broad bash | User accepted: read-only reviewers, pinned installer | ✅ Resolved |
| AR-18 | Security | Mandatory security gates per phase | One security-auditor plus design-challenger / two reviewers everywhere / single reviewer | User accepted: one security-auditor + design-challenger on auth/crypto | ✅ Resolved |
| AR-19 | Security | Fail-closed config, routing, and readiness | Typed boot config, global auth allowlist, real readiness / incremental | User accepted fail-closed boot/routing/readiness | ✅ Resolved |
| AR-20 | Security | Proxy trust and forwarded headers | Trust only proxy CIDR, never publish 8443 / WebAFX hop-count default | User accepted proxy-CIDR-only trust | ✅ Resolved |
| AR-21 | Security | Browser hardening | Strict CSP, no source maps, no-store, CSRF origin checks / defaults | User accepted the hardening set | ✅ Resolved |
| AR-22 | Security | Container hardening | Non-root, read-only rootfs, cap_drop ALL, no-new-privileges, limits / current | User accepted full container hardening | ✅ Resolved |
| AR-23 | Technical | Release pipeline: signed image, SBOM, scan, provenance | Signed amd64 image + SBOM + Trivy/Grype + scheduled rescan + provenance + SHA pins / multi-arch / basic image only | User: "best possible option"; recorded as the signed amd64 pipeline with SBOM, scan, provenance, SHA pins | ✅ Resolved |
| AR-24 | UX & presentation | Minimal UI scope in v0.1 | Login, projects, secrets, permissions, audit / add certificate UI / CLI only | User accepted the minimal UI scope | ✅ Resolved |
| AR-25 | Data & state | Certificate scope | Import + self-signed, no CA/ACME, API/CLI only / add ACME / add UI | User accepted the stated certificate scope | ✅ Resolved |
| AR-26 | Data & state | Secret size and name rules | 64 KiB, `[A-Za-z0-9][A-Za-z0-9-]{0,126}` / other | User accepted 64 KiB and the name regex | ✅ Resolved |
| AR-27 | Behavioral | Audit-before-read and fail-closed audit | Required / best effort | User accepted audit-before-read | ✅ Resolved |
| AR-28 | Behavioral | Concurrent writes and idempotency | Immutable versions + idempotency key + last-write latest / other | User accepted the stated model | ✅ Resolved |
| AR-29 | Security | Bootstrap admin password handling | One-time 0600 file or operator-supplied file, no logs / print to logs | User accepted one-time file, no logs | ✅ Resolved |
| AR-30 | Scope | Deferred features | Accept deferred list / promote any item | User accepted the deferred list | ✅ Resolved |

## Resolution Notes

**Bulk acceptance:** The user said "go with the best possible option". Every open row was recorded as accepting the recommended option. For the single complexity packet (AR-7 and AR-23), the independent `design-challenger` verdict was **Simplify**, and the "best possible" interpretation is the recommended **Simplified larger** option. If the user intended the Full larger option, AR-7/AR-23 must be reopened before implementation.

**AR-1:** The release is a single CodeOps feature. Phases inside the plan are not separate features.

**AR-2:** Browser/admin traffic terminates at the proxy; the server exposes a separate agent mTLS listener. Network isolation is defense in depth, not authentication.

**AR-3:** The AES-256-GCM construction is kept. The keyring API, AAD contract, empty-value handling, and rewrap API are rewritten.

**AR-4:** The server scaffold is rebuilt around typed config, fail-closed routing, two listeners, sessions, CSRF, rate limits, and real readiness.

**AR-5:** Source stays public with private security advisories. No image is published until the release gates pass.

**AR-7 / AR-23 complexity evidence:**
- Original goal: production-grade secrets product with the highest practical security profile.
- Extra system: scoped external review at release candidate; signed amd64 image; SBOM; Trivy/Grype scan plus scheduled rescan; provenance; SHA-pinned actions; mandatory security-auditor gates.
- Smallest solution: internal CodeOps reviews plus dependency audit, CodeQL, Gitleaks, dependency review, branch protection, and a basic non-root image; label alpha/not for production.
- Independent verdict: **Simplify** — keep the security spine, drop multi-arch and blanket duplicate reviewers, scope the external review.
- User choice: best possible option, recorded as Simplified larger.

**AR-8:** The API rejects empty and whitespace-only values with 422. The crypto core still supports empty ciphertext so the primitive has no special case.

**AR-10:** Soft delete 30 days; audit retention 180 days; both configurable within documented bounds.

**AR-12:** In-memory browser sessions in v0.1; a restart signs users out. Redis is a v0.2 optimization.

**AR-13:** Recovery is an offline procedure using the keyring and backup; there is no second always-on admin bypass.

**AR-17:** Reviewer agents get `edit: deny` and a narrow bash allowlist. The CodeOps installer is pinned or vendored; no `npx -y ...@latest`.

**AR-18:** One `security-auditor` gate per security-sensitive phase, plus a `design-challenger` on auth/crypto. The external review is the independent final check.

**AR-27:** A secret read writes the audit event first; if the audit write fails, the read fails closed.

**AR-29:** The bootstrap password is written to a one-time `0600` file or supplied by the operator; it is never printed to container logs.
