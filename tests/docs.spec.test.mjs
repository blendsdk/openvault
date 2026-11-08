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

/** Implementation and assurance records that are kept out of the published docs. */
const internalDocs = new Set([
  "docs/architecture/agent-delivery.md",
  "docs/architecture/crypto.md",
  "docs/architecture/decisions.md",
  "docs/architecture/identity.md",
  "docs/contributing.md",
  "docs/security/claims.md",
  "docs/security/evidence-matrix.md",
  "docs/security/external-review.md",
  "docs/security/limitations.md",
  "docs/security/release-evidence.md",
  "docs/security/release-process.md",
  "docs/security/review-gates.md",
  "docs/security/threat-model.md",
]);

function publicDocs() {
  return ["README.md", ...markdownFiles("docs").filter((file) => !internalDocs.has(file))];
}

/** Terms that belong in code or maintainer records, not in reader documentation. */
const implementationTerms = [
  ["Codex", /\bcodex\b/i],
  ["OpenAI", /\bopenai\b/i],
  ["WebAFX", /\bwebafx\b/i],
  ["React", /\breact\b/i],
  ["Fluent UI", /\bfluent ui\b/i],
  ["TypeScript", /\btypescript\b/i],
  ["Biome", /\bbiome\b/i],
  ["pnpm", /\bpnpm\b/i],
  ["Node.js", /\bnode\.js\b/i],
  ["VitePress", /\bvitepress\b/i],
  ["Cosign", /\bcosign\b/i],
  ["SBOM", /\bsbom\b/i],
  ["provenance", /\bprovenance\b/i],
  ["Trivy", /\btrivy\b/i],
  ["CodeQL", /\bcodeql\b/i],
  ["Gitleaks", /\bgitleaks\b/i],
  ["BuildKit", /\bbuildkit\b/i],
  ["Playwright", /\bplaywright\b/i],
  ["jsdom", /\bjsdom\b/i],
  ["Vitest", /\bvitest\b/i],
  ["Zod", /\bzod\b/i],
  ["OpenAPI", /\bopenapi\b/i],
  ["codegen", /\bcodegen\b/i],
  ["SPA", /\bspa\b/i],
  ["backend", /\bbackend\b/i],
];

describe("documentation version labels", () => {
  it("should not state a 0.x release in user-facing documentation", () => {
    const files = ["README.md", ...markdownFiles("docs")];
    for (const file of files) {
      expect(read(file), relative(root, join(root, file))).not.toMatch(staleVersion);
    }
  });

  it("should state the current release and keep the package version in sync", () => {
    const packageJson = JSON.parse(read("package.json"));

    expect(packageJson.version).toBe("1.1.0");
    expect(read("README.md")).toContain("Current release");
    expect(read("README.md")).toContain("1.1.0");
    expect(read("docs/index.md")).toContain("1.1.0");
    expect(read("docs/guide/versioning.md")).toContain("1.0.0");
    expect(read("docs/guide/versioning.md")).toContain("1.1.0");
  });

  it("should describe the certificate UI and drop the CLI-only limitation", () => {
    const webUi = read("docs/guide/web-ui.md");
    expect(webUi).toContain("Certificates");
    expect(webUi).toContain("Certificate detail");
    expect(webUi).toContain("canRecover");
    expect(webUi).toContain("canReadPrivate");

    const limitations = read("docs/security/known-limitations.md");
    expect(limitations).not.toContain("not the web UI");
    expect(limitations).not.toContain("not in the web UI");
    expect(limitations).toContain("web UI");

    expect(read("docs/guide/certificates.md")).toContain("## Web UI");
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

  it("should keep implementation and assurance details out of reader docs", () => {
    for (const file of publicDocs()) {
      const contents = read(file);
      for (const [term, pattern] of implementationTerms) {
        expect(contents, `${file} mentions ${term}`).not.toMatch(pattern);
      }
    }
  });

  it("should not publish internal assurance pages", () => {
    const config = read("docs/.vitepress/config.ts");
    for (const path of [
      "/security/claims",
      "/security/evidence-matrix",
      "/security/external-review",
      "/security/release-evidence",
      "/security/release-process",
      "/security/review-gates",
      "/security/threat-model",
      "/security/limitations",
      "/architecture/crypto",
      "/architecture/decisions",
      "/architecture/identity",
      "/architecture/agent-delivery",
      "/contributing",
    ]) {
      expect(config, path).not.toContain(`link: "${path}"`);
    }
    expect(config).toContain("srcExclude");
  });

  it("should have a readable docs build input", () => {
    expect(statSync(join(root, "docs/guide/environment-variables.md")).isFile()).toBe(true);
  });
});
