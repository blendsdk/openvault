#!/usr/bin/env node
/**
 * Fail-closed release-label gate.
 *
 * Alpha dispatches are allowed before the independent review, but the image
 * labels and tags say not-for-production. A production tag requires an
 * approved OpenAI Codex Security review for the exact release, the reviewed
 * code commit, and the approval/tag commit, with zero open Critical or High
 * findings.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reviewPath = join(root, "docs/security/external-review.md");
const reportDirectory = join(root, "docs/security");

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

/** Reports whether a value names the Codex scanner rather than a placeholder. */
function isCodexScanner(value) {
  return value === "OpenAI Codex Security";
}

/** Reports whether a value is a full Git commit SHA. */
function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Evaluates one review document.
 *
 * The approval record has two commits: `Reviewed Commit` is the code commit
 * the scanner analyzed; `Commit` is the later approval/tag commit that carries
 * this record. The scanner analyzed the code, while the tag must point at the
 * approval commit so the release workflow can read the record.
 *
 * @param contents - Review file contents, or undefined when absent.
 * @param mode - `alpha` or `production`.
 * @param version - Release label.
 * @param commit - Approval/tag commit the record must cover.
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
  const approvalCommit = field(contents, "Commit");
  const reviewedCommit = field(contents, "Reviewed Commit");
  const scanner = field(contents, "Scanner");
  const scanId = field(contents, "Scan ID");
  const scannedAt = field(contents, "Scanned At");
  const report = field(contents, "Report");
  const critical = Number(field(contents, "Open Critical") ?? "NaN");
  const high = Number(field(contents, "Open High") ?? "NaN");
  if (status !== "Approved") {
    failures.push(`independent review status is ${status ?? "missing"}, not Approved`);
  }
  if (release !== version) {
    failures.push(`independent review covers ${release ?? "no release"}, not ${version}`);
  }
  if (approvalCommit !== commit) {
    failures.push("independent review must record the exact approval/tag Commit");
  }
  if (!isCommitSha(reviewedCommit) || reviewedCommit === "none") {
    failures.push("independent review must record the full Reviewed Commit");
  }
  if (!isCodexScanner(scanner)) {
    failures.push("independent review must record Scanner: OpenAI Codex Security");
  }
  if (scanId === undefined || scanId === "none" || scanId.length === 0) {
    failures.push("independent review must record a Scan ID");
  }
  if (scannedAt === undefined || scannedAt === "none" || scannedAt.length === 0) {
    failures.push("independent review must record Scanned At");
  }
  if (report === undefined || report === "none" || report.length === 0) {
    failures.push("independent review must record a Report path");
  } else if (!existsSync(join(reportDirectory, report))) {
    failures.push(`independent review report is missing: docs/security/${report}`);
  }
  if (!Number.isInteger(critical) || critical !== 0) {
    failures.push("independent review must record Open Critical: 0");
  }
  if (!Number.isInteger(high) || high !== 0) {
    failures.push("independent review must record Open High: 0");
  }
  return failures;
}

/** Runs a negative-control self test against synthetic approval documents. */
function selfTest() {
  const approved = `Status: Approved
Release: v0.1.0
Commit: 1111111111111111111111111111111111111111
Reviewed Commit: 2222222222222222222222222222222222222222
Scanner: OpenAI Codex Security
Scan ID: 33333333-3333-3333-3333-333333333333
Scanned At: 2026-11-08
Open Critical: 0
Open High: 0
Report: external-review.md
`;
  const pending = approved.replace("Status: Approved", "Status: Pending");
  const failures = [];
  if (
    evaluate(approved, "production", "v0.1.0", "1111111111111111111111111111111111111111")
      .length !== 0
  ) {
    failures.push("self-test: approved document was rejected");
  }
  for (const [name, contents] of [
    ["pending", pending],
    [
      "wrong commit",
      approved.replace(/^Commit: .*$/m, "Commit: 4444444444444444444444444444444444444444"),
    ],
    [
      "missing reviewed commit",
      approved.replace(/^Reviewed Commit: .*$/m, "Reviewed Commit: none"),
    ],
    ["wrong scanner", approved.replace("OpenAI Codex Security", "Example Reviewer")],
    ["missing scan id", approved.replace(/^Scan ID: .*$/m, "Scan ID: none")],
    ["missing report", approved.replace(/^Report: .*$/m, "Report: missing.md")],
    ["open high", approved.replace("Open High: 0", "Open High: 1")],
  ]) {
    if (
      evaluate(contents, "production", "v0.1.0", "1111111111111111111111111111111111111111")
        .length === 0
    ) {
      failures.push(`self-test: ${name} document was accepted`);
    }
  }
  if (
    evaluate(pending, "alpha", "v0.1.0-alpha.1", "1111111111111111111111111111111111111111")
      .length !== 0
  ) {
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
