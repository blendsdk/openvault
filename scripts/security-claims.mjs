#!/usr/bin/env node
/**
 * Validates the security-claim ledger and generates its documentation page.
 *
 * Implemented claims need real evidence. Planned claims need a reason and a
 * document that labels the limitation. The checker also scans user-facing
 * documentation for stale phrases that previously described unfinished work.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "docs/security/claims.json");
const outputPath = join(root, "docs/security/claims.md");
const ledger = JSON.parse(readFileSync(sourcePath, "utf8"));
const failures = [];

const STALE_PHRASES = [
  /not bootable/i,
  /until age support lands/i,
  /arrives with the CLI release/i,
  /the release image and .ov init. are part of v0\.1/i,
  /backend is implemented\. the .ov docker scaffold. command that calls it arrives/i,
  /the keyring is plaintext json with mode .0600. until age support lands/i,
  /the v0\.1 schema does not store agent certificate pems, so the pre-backup agent-certificate check is not possible/i,
];

/** Verifies a repository-relative file exists. */
function requireFile(path, context) {
  if (!existsSync(join(root, path))) {
    failures.push(`${context}: missing file ${path}`);
    return undefined;
  }
  return readFileSync(join(root, path), "utf8");
}

/** Validates one evidence item. */
function validateEvidence(item, context) {
  if (item.type === "manual") {
    if (typeof item.check !== "string" || item.check.trim().length === 0) {
      failures.push(`${context}: manual evidence needs a check`);
    }
    requireFile(item.file, context);
    return;
  }
  if (item.type !== "test" && item.type !== "script") {
    failures.push(`${context}: unknown evidence type ${item.type}`);
    return;
  }
  const contents = requireFile(item.file, context);
  if (contents !== undefined && !contents.includes(item.name)) {
    failures.push(`${context}: ${item.file} does not contain ${item.name}`);
  }
}

for (const claim of ledger.claims ?? []) {
  if (!claim.id || !claim.claim || !["implemented", "planned"].includes(claim.status)) {
    failures.push("claims: every claim needs id, claim, and status");
    continue;
  }
  if (!Array.isArray(claim.docs) || claim.docs.length === 0) {
    failures.push(`${claim.id}: no documentation link`);
  }
  for (const doc of claim.docs ?? []) {
    requireFile(doc, claim.id);
  }
  if (claim.status === "implemented") {
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      failures.push(`${claim.id}: implemented claim has no evidence`);
    }
    for (const item of claim.evidence ?? []) {
      validateEvidence(item, claim.id);
    }
  } else {
    if (typeof claim.reason !== "string" || claim.reason.trim().length === 0) {
      failures.push(`${claim.id}: planned claim needs a reason`);
    }
  }
}

/** Recursively lists Markdown files below one directory. */
function markdownFiles(directory) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      results.push(...markdownFiles(path));
    } else if (name.endsWith(".md")) {
      results.push(path);
    }
  }
  return results;
}

for (const path of [join(root, "README.md"), ...markdownFiles(join(root, "docs"))]) {
  const contents = readFileSync(path, "utf8");
  for (const phrase of STALE_PHRASES) {
    if (phrase.test(contents)) {
      failures.push(`${relative(root, path)}: stale security claim ${phrase}`);
    }
  }
}

/** Escapes a Markdown table cell. */
function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Renders the generated claims page. */
function render() {
  const lines = [
    "# Security claims",
    "",
    "> **Generated file.** Run `pnpm security:claims` after changing",
    "> `docs/security/claims.json`. Every implemented claim links to executable",
    "> evidence; every planned claim names the reason and the limiting document.",
    "",
    `Updated: ${ledger.updated ?? "unknown"}`,
    "",
    "| ID | Claim | Status | Evidence or reason |",
    "|---|---|---|---|",
  ];
  for (const claim of ledger.claims ?? []) {
    const detail =
      claim.status === "implemented"
        ? claim.evidence
            .map((item) => `${item.type}: \`${item.file}\` — ${item.name ?? item.check}`)
            .join("<br>")
        : `planned: ${claim.reason}`;
    lines.push(
      `| ${cell(claim.id)} | ${cell(claim.claim)} | ${cell(claim.status)} | ${cell(detail)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`security claims: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  const rendered = render();
  if (process.argv.includes("--write")) {
    writeFileSync(outputPath, rendered);
    process.stdout.write(`Wrote ${outputPath}\n`);
  } else {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== rendered) {
      process.stderr.write(
        "security claims: docs/security/claims.md is stale; run pnpm security:claims\n",
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`SECURITY CLAIMS OK (${ledger.claims.length} claims)\n`);
    }
  }
}
