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
| Release candidate | OpenAI Codex Security review | Pending; see [`external-review.md`](external-review.md) |
| Production label | All gates green, signed image, approved Codex Security review | Blocked until the Codex review is approved |

## Rules

- A Critical finding blocks the phase and the release. No exception.
- A High finding blocks the release; v0.1 requires zero open High findings.
- A reviewer report records the commit or diff it reviewed and a verdict line:
  `Critical: 0`, `High: 0`, `Medium: n`, `Low: n`.
- The release gate script reads the independent-review file, not this summary.

## Current internal reports

The reports were produced by independent review sessions against the RD-13 and
RD-14 working tree. The four High findings (SEC-01, ADR-01, AC-01, AC-02) are
fixed and covered by tests. The Medium/Low disposition is recorded in
`codeops/features/openvault-v0-1/plans/rd-14-release/reviews/00-resolution.md`.
The Codex Security approval remains the only release-specific gate.
