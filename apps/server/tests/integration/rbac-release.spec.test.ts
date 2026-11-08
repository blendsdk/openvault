import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("RBAC release documentation", () => {
  it("should document the assignment, explain, and role catalog routes", () => {
    const api = read("docs/reference/api.md");
    for (const text of [
      "POST /v1/admin/assignments",
      "GET /v1/admin/assignments",
      "DELETE /v1/admin/assignments/:id",
      "GET /v1/admin/access-explain",
      "GET /v1/meta/roles",
      "assignment_conflict",
      "last_org_admin",
      "resource_not_found",
      "policyVersion",
      "canManage",
    ]) {
      expect(api, text).toContain(text);
    }
  });

  it("should explain assignment management and access explanation in the guide", () => {
    const guide = read("docs/guide/rbac.md");
    expect(guide).toContain("/v1/admin/assignments");
    expect(guide).toContain("/v1/admin/access-explain");
    expect(guide).toContain("policyVersion");
  });

  it("should publish the RBAC release note", () => {
    const changelog = read("docs/changelog.md");
    expect(changelog).toContain("## 1.0.0");
    expect(changelog.toLowerCase()).toContain("rbac");
    expect(changelog.toLowerCase()).toContain("role");
  });

  it("should not contain planning identifiers in user documentation", () => {
    for (const path of ["docs/reference/api.md", "docs/guide/rbac.md", "docs/changelog.md"]) {
      const text = read(path);
      for (const pattern of [/\bRD-\d+\b/, /\bAR-\d+\b/, /\bST-\d+\b/, /codeops\//, /plans\//]) {
        expect(text, `${path} ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
