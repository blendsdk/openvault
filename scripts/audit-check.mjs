#!/usr/bin/env node

import { readFileSync } from "node:fs";

const HIGH_SEVERITIES = new Set(["high", "critical"]);

/**
 * Collects advisory-like objects from the supported audit JSON shapes.
 *
 * @param {unknown} report - Parsed audit report.
 * @returns {Array<{ severity?: string }>} Advisories.
 */
function advisories(report) {
  if (!report || typeof report !== "object") {
    return [];
  }
  const value = report;
  const collected = [];
  if (value.advisories && typeof value.advisories === "object") {
    collected.push(...Object.values(value.advisories));
  }
  if (value.vulnerabilities && typeof value.vulnerabilities === "object") {
    collected.push(...Object.values(value.vulnerabilities));
  }
  return collected.filter((entry) => entry && typeof entry === "object");
}

/**
 * Runs the audit fixture check.
 *
 * @returns {number} Process exit code.
 */
function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("Usage: audit-check.mjs <audit-json-file>\n");
    return 2;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    process.stderr.write("Audit report is not valid JSON.\n");
    return 2;
  }

  const findings = advisories(report).filter((entry) =>
    HIGH_SEVERITIES.has(String(entry.severity).toLowerCase()),
  );
  if (findings.length > 0) {
    process.stderr.write(`Found ${findings.length} high or critical advisory entries.\n`);
    return 1;
  }

  process.stdout.write("No high or critical advisories.\n");
  return 0;
}

process.exitCode = main();
