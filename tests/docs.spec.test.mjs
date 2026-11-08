import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.name === ".vitepress") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

/** Matches a 0.x release label, not an IP address or a decimal version. */
const staleVersion = /\bv0\.\d+(?:\.\d+)?\b|\b0\.[123]\.\d+\b/;

describe("documentation version labels", () => {
  it("should not state a 0.x release in user-facing documentation", () => {
    const files = ["README.md", ...markdownFiles("docs")];
    for (const file of files) {
      expect(read(file), relative(root, join(root, file))).not.toMatch(staleVersion);
    }
  });

  it("should state the current release and keep the package version in sync", () => {
    const packageJson = JSON.parse(read("package.json"));

    expect(packageJson.version).toBe("1.0.1");
    expect(read("README.md")).toContain("Current release");
    expect(read("README.md")).toContain("1.0.1");
    expect(read("docs/index.md")).toContain("1.0.1");
    expect(read("docs/guide/versioning.md")).toContain("1.0.0");
    expect(read("docs/guide/versioning.md")).toContain("1.0.1");
  });

  it("should record the release in the CodeOps roadmaps", () => {
    const featureRoadmap = read("codeops/features/openvault-v0-1/00-roadmap.md");
    const portfolioRoadmap = read("codeops/00-roadmap.md");

    expect(featureRoadmap).toContain("OpenVault v1.0");
    expect(featureRoadmap).toContain("v1.0.1");
    expect(portfolioRoadmap).toContain("v1.0.1");
  });
});

describe("documentation positioning", () => {
  it("should not position the product by its implementation stack", () => {
    const files = ["README.md", "docs/index.md", "docs/architecture/overview.md", "package.json"];
    for (const file of files) {
      expect(read(file).toLowerCase(), file).not.toContain("built on blendsdk");
    }
    expect(read("docs/index.md")).not.toContain("Built on BlendSDK");
  });

  it("should document the environment-variable loader pattern", () => {
    expect(read("docs/.vitepress/config.ts")).toContain('link: "/guide/environment-variables"');
    expect(read("docs/guide/environment-variables.md")).toContain("loader");
    expect(read("examples/compose-env/README.md")).toContain("APP_API_TOKEN");
  });

  it("should have a readable docs build input", () => {
    expect(statSync(join(root, "docs/guide/environment-variables.md")).isFile()).toBe(true);
  });
});
