# Ambiguity Register: RD-14 Release Assurance

> **Status**: ✅ GATE PASSED — all 11 items resolved
> **Last Updated**: 2026-11-06 18:00

| # | Category | Ambiguity / Gap | Options Presented | Decision | Status |
|---|----------|-----------------|-------------------|----------|--------|
| 1 | Evidence | How is the threat-model matrix kept current? | Prose only / JSON ledger + generated page + checker | One JSON ledger, a generated Markdown page, and a check in `pnpm verify`. Every row needs a test file containing the named test or a documented manual check. | ✅ Resolved |
| 2 | Evidence | How is "every security-sensitive RD has a spec test" enforced? | Convention / list + checker | The ledger lists required spec files per RD and the checker fails if one is missing. | ✅ Resolved |
| 3 | Review | Who performs the internal security gates? | Skip / external only / CodeOps reviewers | Use independent general-purpose reviewer sessions with security, correctness, and design prompts; store signed-off reports under the plan. | ✅ Resolved |
| 4 | Review | What about the independent external review? | Claim it happened / block production / omit | Prepare the packet and a strict approval file. The release workflow refuses a production label until the file says approved. This is the one operator-provided gate. | ✅ Resolved |
| 5 | Release | How is an alpha image published before external review? | No alpha / labelled alpha | Manual `workflow_dispatch` with mode `alpha`; image and OCI labels say `not-for-production`. Tag pushes are production candidates and require the external-review gate. | ✅ Resolved |
| 6 | Release | How are SBOM and provenance produced? | Separate tool / BuildKit attestations + Syft asset | BuildKit `sbom` and `provenance` attestations plus a Syft SPDX asset attached to the GitHub release. | ✅ Resolved |
| 7 | Release | Which scanner blocks a release? | Trivy / Grype / both | Trivy at release and on a weekly schedule. Fail on HIGH and CRITICAL. | ✅ Resolved |
| 8 | Supply chain | How are actions pinned? | Tags / full commit SHAs | Full commit SHAs for every action, including the new release and scan actions. | ✅ Resolved |
| 9 | Supply chain | Is branch protection already correct? | Assume / verify / implement | Verified through the GitHub API: PR required, strict checks, linear history, no force push, no deletion. Record the evidence. | ✅ Resolved |
| 10 | Docs | How is the docs-accuracy gate enforced? | Manual review / claims ledger + checker | Add a security-claims ledger with implemented/planned status and evidence links; the checker fails on implemented claims whose evidence is missing or planned claims missing a label. | ✅ Resolved |
| 11 | Scope | Does RD-14 add real-browser accessibility checks? | Yes / defer | Defer Playwright to the release candidate runbook; RD-12 already documents the jsdom axe scope. The release checklist names the manual browser check. | ✅ Resolved |
