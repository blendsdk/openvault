#!/usr/bin/env node
/**
 * Fail-closed release-label gate.
 *
 * Alpha dispatches are allowed before the external review, but the image labels
 * and tags say not-for-production. A production tag requires an approved
 * external review for the exact release, commit, and zero open Critical/High
 * findings.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reviewPath = join(root, "docs/security/external-review.md");

/** Reads one `Key: value` line, accepting blockquotes and bold markers. */
export function field(contents, name) {
  const match = new RegExp(`^\\s*(?:>\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.*)$`, "m").exec(
    contents,
  );
  return match?.[1]
    ?.trim()
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

/** Parses `--name value` arguments. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * Evaluates one review document.
 *
 * @param contents - Review file contents, or undefined when absent.
 * @param mode - `alpha` or `production`.
 * @param version - Release label.
 * @param commit - Commit the approval must cover.
 * @returns Failure messages.
 */
export function evaluate(contents, mode, version, commit) {
  const failures = [];
  if (mode !== "alpha" && mode !== "production") {
    failures.push(`unknown release mode: ${mode}`);
    return failures;
  }
  if (mode === "alpha") {
    return failures;
  }
  if (contents === undefined) {
    failures.push("docs/security/external-review.md is missing");
    return failures;
  }
  const status = field(contents, "Status");
  const release = field(contents, "Release");
  const reviewedCommit = field(contents, "Commit");
  const reviewer = field(contents, "Reviewer");
  const critical = Number(field(contents, "Open Critical") ?? "NaN");
  const high = Number(field(contents, "Open High") ?? "NaN");
  if (status !== "Approved") {
    failures.push(`external review status is ${status ?? "missing"}, not Approved`);
  }
  if (release !== version) {
    failures.push(`external review covers ${release ?? "no release"}, not ${version}`);
  }
  if (reviewedCommit === undefined || reviewedCommit === "none" || reviewedCommit !== commit) {
    failures.push("external review must record the exact Commit under review");
  }
  if (reviewer === undefined || reviewer === "not assigned" || reviewer.length === 0) {
    failures.push("external review must name a Reviewer");
  }
  if (!Number.isInteger(critical) || critical !== 0) {
    failures.push("external review must record Open Critical: 0");
  }
  if (!Number.isInteger(high) || high !== 0) {
    failures.push("external review must record Open High: 0");
  }
  return failures;
}

/** Runs a negative-control self test against synthetic approval documents. */
function selfTest() {
  const approved = `Status: Approved
Release: v0.1.0
Commit: abc123
Reviewer: Example Reviewer
Open Critical: 0
Open High: 0
`;
  const pending = approved.replace("Status: Approved", "Status: Pending");
  const failures = [];
  if (evaluate(approved, "production", "v0.1.0", "abc123").length !== 0) {
    failures.push("self-test: approved document was rejected");
  }
  for (const [name, contents] of [
    ["pending", pending],
    ["wrong commit", approved.replace("abc123", "def456")],
    ["open high", approved.replace("Open High: 0", "Open High: 1")],
  ]) {
    if (evaluate(contents, "production", "v0.1.0", "abc123").length === 0) {
      failures.push(`self-test: ${name} document was accepted`);
    }
  }
  if (evaluate(pending, "alpha", "v0.1.0-alpha.1", "abc123").length !== 0) {
    failures.push("self-test: alpha was rejected");
  }
  return failures;
}

const mode = option("mode", "alpha");
const version = option("version", "v0.0.0-alpha");
const commit = option("commit", process.env.GITHUB_SHA ?? "unknown");
const contents = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : undefined;
const failures = evaluate(contents, mode, version, commit);
if (process.argv.includes("--self-test")) {
  failures.push(...selfTest());
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`release gate: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    mode === "production"
      ? `RELEASE GATE OK: production ${version} is approved for ${commit}\n`
      : `RELEASE GATE OK: alpha ${version} is not for production\n`,
  );
}
