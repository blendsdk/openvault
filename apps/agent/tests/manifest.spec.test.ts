import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { loadAgentManifest } from "../src/manifest.js";

const directories: string[] = [];

function tempManifest(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-manifest-"));
  directories.push(directory);
  const path = join(directory, "manifest.yaml");
  writeFileSync(path, text);
  return path;
}

function load(text: string, mode: "sidecar" | "wrapper" = "sidecar"): unknown {
  return loadAgentManifest(tempManifest(text), {
    project: "payments",
    service: "api",
    outputDir: "/run/secrets",
    mode,
  });
}

const valid = `project: payments
service: api
refresh: 300s
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
  - name: stripe-key
    file: stripe_key
    mode: "0400"
`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("manifest", () => {
  it("should parse a valid manifest and hash the raw bytes", () => {
    const manifest = load(valid) as { refreshMs: number; hash: string; entries: unknown[] };
    expect(manifest.refreshMs).toBe(300_000);
    expect(manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.entries).toHaveLength(2);
  });

  it("should reject unknown fields", () => {
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
    optional: true
    typo: true
`),
    ).toThrow(/schema/);
  });

  it.each(["../escape", "/abs", "a/b", ".", ".."])(
    "should reject an unsafe file target %s",
    (file) => {
      expect(() =>
        load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: "${file}"
`),
      ).toThrow(/safe names/);
    },
  );

  it("should reject duplicate names, files, and env names", () => {
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: same
  - name: db-password
    file: other
`),
    ).toThrow(/unique/);
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: same
  - name: other
    file: same
`),
    ).toThrow(/unique/);
  });

  it("should accept both file and env targets in wrapper mode only", () => {
    const text = `project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
    env: DB_PASSWORD
`;
    expect(load(text, "wrapper")).toBeDefined();
    expect(() => load(text, "sidecar")).toThrow(/sidecar/);
  });

  it("should reject an entry without a target and a mode without a file", () => {
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
`),
    ).toThrow(/requires/);
    expect(() =>
      load(
        `project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    env: DB_PASSWORD
    mode: "0400"
`,
        "wrapper",
      ),
    ).toThrow(/mode/);
  });

  it("should reject unsafe modes", () => {
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
    mode: "0777"
`),
    ).toThrow(/mode/);
  });

  it("should reject a mismatched project, service, or output directory", () => {
    expect(() =>
      load(`project: other
service: api
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
`),
    ).toThrow(/project/);
    expect(() =>
      load(`project: payments
service: other
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
`),
    ).toThrow(/service/);
    expect(() =>
      load(`project: payments
service: api
output_dir: /other
entries:
  - name: db-password
    file: db_password
`),
    ).toThrow(/output_dir/);
  });

  it("should bound the refresh interval", () => {
    expect(() =>
      load(`project: payments
service: api
refresh: 29s
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
`),
    ).toThrow(/refresh/);
    expect(() =>
      load(`project: payments
service: api
refresh: 86400s
output_dir: /run/secrets
entries:
  - name: db-password
    file: db_password
`),
    ).toBeDefined();
  });

  it("should reject duplicate YAML keys", () => {
    expect(() =>
      load(`project: payments
service: api
output_dir: /run/secrets
output_dir: /other
entries:
  - name: db-password
    file: db_password
`),
    ).toThrow(/duplicate/);
  });

  it("should validate the configuration URL and required values", () => {
    expect(() =>
      loadAgentConfig({
        OPENVAULT_URL: "http://vault.example.com",
        OPENVAULT_CA_FILE: "/ca.pem",
        OPENVAULT_PROJECT: "payments",
        OPENVAULT_SERVICE: "api",
        COMPOSE_PROJECT_NAME: "payments",
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      loadAgentConfig({
        OPENVAULT_URL: "https://vault.example.com",
        OPENVAULT_CA_FILE: "/ca.pem",
        OPENVAULT_PROJECT: "payments",
        OPENVAULT_SERVICE: "api",
      }),
    ).toThrow(/COMPOSE_PROJECT_NAME/);
  });
});
