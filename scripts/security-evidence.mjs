#!/usr/bin/env node
/**
 * Validates and renders the security evidence matrix.
 *
 * Usage:
 *   node scripts/security-evidence.mjs --write   # regenerate the Markdown page
 *   node scripts/security-evidence.mjs           # fail if the page is stale
 *
 * Every threat row needs at least one piece of evidence. Test and script
 * evidence must name a real file and a symbol or test title that appears in it.
 * Manual evidence must name a real document and a non-empty check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "docs/security/evidence-matrix.json");
const outputPath = join(root, "docs/security/evidence-matrix.md");
const matrix = JSON.parse(readFileSync(sourcePath, "utf8"));
const failures = [];

/** Verifies a repository-relative file exists. */
function requireFile(path, context) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    failures.push(`${context}: missing file ${path}`);
    return undefined;
  }
  return readFileSync(absolute, "utf8");
}

/** Verifies one evidence item. */
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

if (!Array.isArray(matrix.threats) || matrix.threats.length === 0) {
  failures.push("matrix: threats must be a non-empty array");
}
for (const threat of matrix.threats ?? []) {
  if (!threat.id || !threat.threat || !threat.protection) {
    failures.push("matrix: every threat needs id, threat, and protection");
  }
  if (!Array.isArray(threat.evidence) || threat.evidence.length === 0) {
    failures.push(`${threat.id}: no evidence`);
  }
  for (const item of threat.evidence ?? []) {
    validateEvidence(item, threat.id);
  }
}
for (const category of matrix.securityCategories ?? []) {
  if (!Array.isArray(category.evidence) || category.evidence.length === 0) {
    failures.push(`${category.id}: no evidence`);
  }
  for (const item of category.evidence ?? []) {
    validateEvidence(item, category.id);
  }
}
for (const requirement of matrix.requiredSpecs ?? []) {
  if (!Array.isArray(requirement.files) || requirement.files.length === 0) {
    failures.push(`${requirement.rd}: no spec file`);
  }
  for (const file of requirement.files ?? []) {
    requireFile(file, requirement.rd);
  }
}

/** Escapes a Markdown table cell. */
function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Renders the generated page. */
function render() {
  const lines = [
    "# Security evidence matrix",
    "",
    "> **Generated file.** Run `pnpm security:evidence` after changing",
    "> `docs/security/evidence-matrix.json`. The `pnpm verify` gate fails when this",
    "> page is stale or a linked test is missing.",
    "",
    `Updated: ${matrix.updated ?? "unknown"}`,
    "",
    "## Threat-model coverage",
    "",
    "| ID | Threat | Protection | Evidence |",
    "|---|---|---|---|",
  ];
  for (const threat of matrix.threats ?? []) {
    const evidence = threat.evidence
      .map((item) =>
        item.type === "manual"
          ? `manual: ${item.file}`
          : `${item.type}: \`${item.file}\` — ${item.name}`,
      )
      .join("<br>");
    lines.push(
      `| ${cell(threat.id)} | ${cell(threat.threat)} | ${cell(threat.protection)} | ${cell(evidence)} |`,
    );
  }
  lines.push("", "## Required specification files", "", "| RD | Files |", "|---|---|");
  for (const requirement of matrix.requiredSpecs ?? []) {
    lines.push(
      `| ${cell(requirement.rd)} | ${requirement.files.map((file) => `\`${file}\``).join("<br>")} |`,
    );
  }
  lines.push("", "## Named security categories", "", "| Category | Evidence |", "|---|---|");
  for (const category of matrix.securityCategories ?? []) {
    const evidence = category.evidence
      .map((item) =>
        item.type === "manual" ? `manual: ${item.file}` : `\`${item.file}\` — ${item.name}`,
      )
      .join("<br>");
    lines.push(`| ${cell(category.label)} | ${cell(evidence)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`security evidence: ${failure}\n`);
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
        "security evidence: docs/security/evidence-matrix.md is stale; run pnpm security:evidence\n",
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `SECURITY EVIDENCE OK (${matrix.threats.length} threats, ${matrix.requiredSpecs.length} RDs)\n`,
      );
    }
  }
}
