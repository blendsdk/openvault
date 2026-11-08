# Review gates

Every security-sensitive phase has a named reviewer and a stored report. The
reports live under
`codeops/features/openvault-v0-1/plans/rd-14-release/reviews/`.

| Phase | Reviewer gate | Status |
|---|---|---|
| Requirements | Zero-Ambiguity Gate and preflight | Passed for RD-13 and RD-14 |
| Crypto and keyring | Security auditor plus design challenger | See `crypto-auth-security.md` and `auth-crypto-design-challenge.md` |
| Auth and sessions | Security auditor plus correctness reviewer | See `crypto-auth-security.md` |
| Audit | Security auditor plus tamper tests | See `audit-data-review.md` |
| Agent and deploy | Security auditor plus concurrency reviewer | See `agent-deploy-review.md` |
| Manual security scan | OpenAI Codex Security, run by the maintainer when convenient | Advisory; see [`external-review.md`](external-review.md) |

## Rules

- An internal review finding at Critical or High severity blocks the phase it
  covers until it is fixed.
- A reviewer report records the commit or diff it reviewed and a verdict line:
  `Critical: 0`, `High: 0`, `Medium: n`, `Low: n`.
- The OpenAI Codex Security scan is a manual, periodic check. It is not part of
  CI/CD, has no machine-readable approval gate, and does not block a release.

## Current internal reports

The reports were produced by independent review sessions against the RD-13 and
RD-14 working tree. The four High findings (SEC-01, ADR-01, AC-01, AC-02) are
fixed and covered by tests. The Medium/Low disposition is recorded in
`codeops/features/openvault-v0-1/plans/rd-14-release/reviews/00-resolution.md`.
