# Reasoning effort (shared contract)

> **CodeOps Artifact Schema**: 1

CodeOps subagents normally inherit the parent session's model variant, so a top-tier parent
would pay top-tier reasoning cost for every child dispatch. Adaptive reasoning effort lets an
explicit source pick a level per dispatch or per skill run. This document is the shipped
contract consumed by the plugin and the skills. It is advisory by design and never a gate.

## Levels

| Level | Meaning | Typical work |
| ----- | ------- | ------------ |
| `low` | Mechanical, fully specified, deterministic verification | Docs and formatting edits, renames, config updates |
| `medium` | Ordinary bounded feature work with known patterns | Standard implementation phases, recon, single-file reviews |
| `high` | Correctness- or security-sensitive, cross-cutting, or planning/review work | Requirements, planning, correctness/security review, ambiguous implementation |
| `max` | Adversarial or high-risk analysis where a missed detail is costly | Thorough preflight, complex or sensitive phases |

The four levels are the complete suggestion vocabulary. A level is applied through the model's
own variant options: the exact variant when it exists, otherwise the nearest exposed level on the
provider scale, with ties resolving to the higher level. On OpenCode 2 the plugin reads those
options from the registered model's `variants` collection and merges the chosen entry's settings
into the request. `none` stays exact-match only, because mapping it to a reasoning level would
enable reasoning the caller disabled. When no variant can be chosen — the model exposes no
matching variant — the request is left unchanged, and it never raises a provider error. Routing
policy is project configuration, not a suggestion:
`routing.roles.<agent>.reasoning` may name any value from the provider enum (`none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`).

The deepseek flash model in this environment exposes `low`, `high`, and `max`, so a `medium`
suggestion resolves to `high` there. Confirm the active model's set by enabling
`CODEOPS_EFFORT_TRACE=1` and reading `variantLevels` on an apply line.

## Marker grammar

A dispatch marker is one standalone line in a dispatch message:

```text
[codeops-effort: <level>]
```

- The whole trimmed line must match `^\[codeops-effort:\s*(low|medium|high|max)\]\s*$`.
- The level is exactly lower-case. Unknown or malformed markers are ignored, never errors.
- Only user-role text parts of a message are scanned; tool output, diffs, and quoted documents
  are never scanned.
- The first valid marker in message order wins; additional markers are ignored.
- The marker is deliberately distinct from the human-readable plan line
  `> **Reasoning**: ...`, so a quoted plan line can never act as a machine directive.

For quality-agent packets the marker follows the dispatch header; for packet kinds without a
header it is the first line. `exec-plan` owns the composition rule.

A captured marker is remembered for the whole session: every request in that session uses it
until a newer marker replaces it or the session ends. This is what keeps the marker effective
when the host passes a later user message to the request hook.

## Precedence

The most specific source wins:

```text
dispatch marker  >  session auto-effort  >  routing.roles[<agent>].reasoning  >  inherit parent variant
```

| Source | Scope | Owner |
| ------ | ----- | ----- |
| Dispatch marker | One child dispatch | `exec-plan` composes it from the phase suggestion or the run's forced level |
| Session auto-effort | One skill run in the user's session | `--auto-effort` through `scripts/codeops_effort.py` |
| Routing role default | Project policy for one agent name | `codeops/codeops.json` → `routing.roles.<agent>.reasoning` |
| Inherit | Everything else | The child keeps the parent model and variant |

Routing lookup applies only when the dispatching agent's name has an explicit `routing.roles`
entry. There are no built-in catalog defaults, hand-authored agents are untouched, and
generated specialists keep their embedded value unless the project adds a routing entry.

## Skill recommendation table

Used for suggestions and for a bare `--auto-effort`:

| Skill | Recommended level | Notes |
| ----- | ----------------- | ----- |
| `make-requirements` | `high` | Structured discovery and gap expansion |
| `make-plan` | `high` | Decomposition plus the Zero-Ambiguity Gate |
| `preflight` | `high`; `max` with `--thorough` | Adversarial multi-dimension audit |
| `grill-me` | `high` | Branch-by-branch disambiguation |
| `exec-plan` | current phase's `Reasoning:` level | Bare flag follows the phase; `=<level>` forces a constant |
| `retro-requirements` | `high` | Nine-phase archaeology |
| `upgrade-plan` | `high` | Content gate plus structural migration |
| `setup-codeops`, `setup-routing` | `high` (reference only) | Structure and policy authoring |
| `techdocs`, `analyze-project`, `clean-comments`, `outcome-review` | `medium` (reference only) | Structured but bounded |
| `roadmap`, `git-commit`, `github-issues` | `low` (reference only) | Mechanical bookkeeping |

Skills that accept `--auto-effort` are `make-requirements`, `make-plan`, `preflight`,
`grill-me`, `exec-plan`, `retro-requirements`, and `upgrade-plan`. Other skills document their
recommended levels for reference only and do not implement the flag.

## Plan suggestion derivation

`make-plan` derives an advisory level for every phase and every task mini-plan from signals it
already records:

| Signal | Suggested level |
| ------ | --------------- |
| Phase carries a complexity escalation approval, or a complex/sensitive tag | `max` |
| Phase carries a security, financial-integrity, concurrency, performance-critical, compiler-semantics, or migration lens/risk tag | `high` |
| Docs/config/rename-only phase with deterministic verification | `low` |
| Any other non-trivial phase | `medium` |

The runtime maps a missing level to the nearest exposed variant, so the four levels remain valid
suggestions on every reasoning-capable model.

The line is written as `> **Reasoning**: <level> — <one-line reason>`. It is a suggestion: the
user may edit or delete it, and `exec-plan` never blocks on it. A plan without the line keeps
the inherited behavior.

## Auto-effort option

Skills listed above accept the flag. Parsing follows the existing standalone-token pattern
(`--auto-design`, `--explore-scope`): exactly one occurrence before the first `--` sentinel,
removed before resolving targets, paths, or modes; zero means advise-only; more than one or an
invalid `=<level>` is an argument error.

| Flag | Behavior |
| ---- | -------- |
| *(absent)* | Print `Suggested reasoning: <level> — <reason>` once at start (`exec-plan`: before each phase); change nothing |
| `--auto-effort` | Use the skill's recommended level (`exec-plan`: the current phase level) |
| `--auto-effort=<level>` | Use the named level; reject values outside the four-level set |

Semantics:

1. Announce `Auto-effort active — reasoning <level> applied for this run`.
2. Record the level for the run in the runtime scratch directory through
   `scripts/codeops_effort.py`. When one runtime serves more than one concurrent session, the
   most recently recorded level applies to all of them.
3. Clear it at run completion, before the final summary.
4. Run-scoped: the level applies from the point it is set until cleared or the session ends.
5. Fail-open: when the runtime scratch directory is unavailable or the helper fails, print an
   advise-only note and continue; the skill never blocks.
6. Never a gate: effort affects cost and latency only. No readiness check, verification step,
   reviewer requirement, or finding gate may read it.

For `exec-plan`, a bare flag follows each phase's suggestion, while `--auto-effort=<level>`
forces that level for the whole run, including every dispatch marker composed during it.

## Optional tracing

Set `CODEOPS_EFFORT_TRACE=1` (or `true`) in the environment that starts OpenCode to record what
the plugin does. One content-free JSON line is appended per marker capture and per request to
`reasoning-effort-trace.jsonl` inside the runtime's scratch directory. Lines carry only a
timestamp, session id, event name, message id, agent name, level, source, chosen variant, and
applied flag — never prompt text or file content. The trace lives with the rest of the runtime
scratch and is removed with it. Tracing is off by default and never affects a request.

## Suggestion-only guarantee

| Allowed | Forbidden |
| ------- | --------- |
| Printing a suggested level and its reason | Blocking a run because a level is missing or unsupported |
| Applying a level when a marker, flag, or routing entry explicitly asks | Overriding an explicit user plan edit with a derived default |
| Reporting the applied level and its source | Treating effort as an acceptance, review, or security control |
