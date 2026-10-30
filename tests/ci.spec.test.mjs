import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowDirectory = join(process.cwd(), ".github", "workflows");
const workflowFiles = readdirSync(workflowDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => ({
    name: file,
    source: readFileSync(join(workflowDirectory, file), "utf8"),
  }));

describe("workflow security policy", () => {
  it("should pin every action to a full commit SHA with a tag comment", () => {
    for (const workflow of workflowFiles) {
      for (const line of workflow.source.split("\n")) {
        const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/);
        if (!match) {
          continue;
        }
        expect(match[1], `${workflow.name}: ${line.trim()}`).toMatch(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[0-9a-f]{40}$/,
        );
        expect(match[2], `${workflow.name}: missing tag comment`).toBeTruthy();
      }
    }
  });

  it("should use least-privilege workflow permissions and disable persisted credentials", () => {
    for (const workflow of workflowFiles) {
      expect(workflow.source).not.toContain("pull_request_target");
      if (workflow.source.includes("uses: actions/checkout@")) {
        expect(workflow.source).toContain("persist-credentials: false");
      }
    }

    const docs = workflowFiles.find((workflow) => workflow.name === "docs.yml");
    expect(docs).toBeDefined();
    const topLevel = docs.source.split("jobs:")[0];
    expect(topLevel).toContain("contents: read");
    expect(topLevel).not.toContain("pages: write");
    expect(topLevel).not.toContain("id-token: write");
    const deploy = docs.source.split("deploy:")[1] ?? "";
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
  });

  it("should run the full verification, audit, and PostgreSQL integration gates", () => {
    const ci = workflowFiles.find((workflow) => workflow.name === "ci.yml");
    expect(ci).toBeDefined();
    expect(ci.source).toContain("pnpm verify");
    expect(ci.source).toContain("pnpm audit:prod");
    expect(ci.source).toContain("pnpm audit:full");
    expect(ci.source).toContain("pnpm test:integration");
    expect(ci.source).toMatch(/postgres:\$\{\{ matrix\.postgres \}\}-alpine/);
    expect(ci.source).toMatch(/postgres: \[16, 17\]/);
    expect(ci.source).toContain("pnpm db:types:check");
  });
});
