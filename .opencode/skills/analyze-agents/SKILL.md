---
name: analyze-agents
description: Run the project-level specialist check on demand. Reads the repository's requirements, plans, findings ledgers, and manifests directly (no script), applies the specialist-agent detection criteria, presents at most two evidence-backed lightweight proposals or a None with evidence, and records the check state consumed by the analyze-project coverage line.
---

# analyze-agents

Run this check to re-evaluate whether a project would benefit from a project-specific specialist
subagent — on request, or because `analyze-project` reported the coverage as due. This skill is the
execution surface for the detection criteria in
[`../../_shared/specialist-agents.md`](../../_shared/specialist-agents.md); it reads the
repository's own artifacts and never invokes a script.

## Evidence

Read these sources for the current project. All paths are layout-aware per
[`../../_shared/layout-convention.md`](../../_shared/layout-convention.md): flat `plans/` or nested
`codeops/features/<f>/plans/`.

- requirements and plan documents — domain/lens tags and scope history;
- per-plan findings ledgers (`05-findings.md`) — finding-area recurrence;
- manifests (`package.json`, `pyproject.toml`, `go.mod`, and similar) — specialized framework,
  DSL, codegen, or protocol signals;
- existing `codeops/specialists/` briefs and `codeops/codeops.json` routing roles —
  deduplicate against installed specialists;
- `codeops/specialist-check.json` — the prior check state.

## Detection flow

1. Collect the evidence sources above.
2. Apply the detection criteria and disqualifiers from the protocol document: a candidate needs
   evidenced strong signal(s) and no disqualifier.
3. Recurrence anchor: one area appearing in at least two plans or three findings ranks as a strong
   signal; thresholds anchor judgment, not hard gates.
4. Present at most two candidates in one batch as **lightweight proposals** — role slug, kind, a
   one-line capability, evidence with `file:line`, and the smallest alternative with why it is
   insufficient — or record `None` with evidence.
5. Write the check state (below) on every run, including a `None` outcome.
6. Hand-off: on user interest, hand off to the `setup-routing` flow for creation. Never create or
   modify agent files, briefs, routing policy, or `AGENTS.md`.

## Check state

Write `codeops/specialist-check.json` (project-level in both layouts; create the `codeops/`
directory lazily when it does not exist):

```json
{
  "checkedAt": "<ISO-8601 timestamp>",
  "plans": ["<plan folder>", "<plan folder>"]
}
```

The `plans` list contains the plan folders present at check time (layout-aware). Consumers treat
absent, unreadable, or malformed state as **never checked** and recommend a run — fail loud, never
silent.

## Output

A short human summary: the candidate proposals in the lightweight format above, or `None` with
evidence, plus the state write result. The state file is the machine-readable artifact; there is no
separate JSON output mode.

## Degradation

- Missing findings ledger: the output states that the ledger was missing and the check ran on
  reduced evidence (documents and manifests only).
- Malformed ledger rows: skip the row with a note; never guess its fields.
- Empty repository (no plans or requirements): record `None` with evidence and still write the
  check state.

---

> **Workspace hygiene (non-negotiable):** put every temporary artifact this run creates in
> `$CODEOPS_TMPDIR` (fallback: the OS temp directory), never in the repository, and delete them
> all before reporting completion. Never delete user files, versioned artifacts, worktrees, or
> another session's temporary files. Full rules:
> [_shared/workspace-hygiene.md](../../_shared/workspace-hygiene.md).
