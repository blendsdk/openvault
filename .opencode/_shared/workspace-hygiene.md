# Workspace hygiene (shared convention)

> **CodeOps Artifact Schema**: 1

This is the **single canonical definition** of CodeOps temporary-artifact hygiene. Every skill,
agent, and script that creates files outside its assigned deliverables follows it. Skills link
here instead of carrying copies.

## Temporary artifacts

A temporary artifact is any file or directory a run creates that is not a durable deliverable:
verification logs, diffs, patch files, commit-message files, scratch directories, fixture trees,
downloaded artifacts, and intermediate reports. Code, tests, plan documents, and other assigned
outputs are deliverables — not temporary artifacts — and they are never deleted here.

## Where temporary artifacts live

1. `$CODEOPS_TMPDIR` when the CodeOps plugin exports it (one directory per OpenCode runtime).
   Use it for every scratch file.
2. Otherwise, the operating system's temp directory.
3. Never inside the repository. A repository path is durable space; scratch does not belong there.

Create subdirectories under the temp root lazily, only when the task needs them.

OpenCode 2 does not expose a session identifier to shell hooks, so the plugin owns one scratch
directory per runtime instead of one per session. Sessions served by the same runtime share it;
keep scratch file names specific to the run to avoid collisions.

## Lifecycle

1. **Create lazily** — write a temporary file only when the task needs it.
2. **Keep only while needed** — one artifact per purpose; no accumulating copies.
3. **Delete before reporting completion** — every task, phase, skill run, and session ends with a
   cleanup pass that removes the files and directories the run created, including verification
   logs.
4. **Report the result** — the final summary states `Cleanup: done`, or names the artifact that
   was kept and why. If a deletion fails, report the path and the reason.

## Safe deletion rules (non-negotiable)

- Delete only files you created, and only under the sanctioned temp root.
- Never delete user files, repository content, versioned artifacts, `codeops/` planning artifacts,
  or git worktrees.
- Never delete another session's temporary files.
- Never follow a symlink out of the temp root; treat a symlinked entry as foreign and leave it.
- Never run a broad recursive delete against a path that may be empty or unset; resolve and verify
  the path first.
- A temporary file must not hold secrets. If one does, delete it and say so without printing its
  contents.
- If the user asks for an artifact to be kept, name its exact path and keep that file only.

## Automatic safety net

The CodeOps plugin exports `$CODEOPS_TMPDIR` for each runtime. At startup it removes CodeOps
temp directories older than seven days, so an interrupted run cannot leak storage forever.
The plugin never deletes a runtime's directory while sessions may still be running — several
sessions can share one directory, so reclamation happens only through the age-based sweep.
The safety net is a fallback, not a substitute: the run itself still performs the cleanup
pass above.
