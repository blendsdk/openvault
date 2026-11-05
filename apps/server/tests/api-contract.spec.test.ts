import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildApiDocument,
  buildWebApiDocument,
  CONTRACT_CONTROLLERS,
  checkContract,
  generateContract,
  joinPath,
  ROUTE_DOCS,
  routeKey,
  WEB_CONTRACT_CONTROLLERS,
  WEB_ROUTE_DOCS,
} from "../scripts/api-contract.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-contract-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface DocumentShape {
  readonly paths: Record<
    string,
    Record<string, { readonly operationId?: string; readonly security?: unknown[] }>
  >;
}

describe("CLI API contract", () => {
  it("should document every route on every contract controller", async () => {
    const document = (await buildApiDocument()) as unknown as DocumentShape;
    const documented = new Set(Object.keys(ROUTE_DOCS));
    const seen = new Set<string>();
    for (const registration of CONTRACT_CONTROLLERS) {
      const controller = new registration.controller({}, {});
      for (const route of controller.routes()) {
        const key = routeKey(route.method, joinPath(registration.basePath, route.path));
        expect(documented.has(key), `missing metadata for ${key}`).toBe(true);
        expect(seen.has(key), `duplicate real route ${key}`).toBe(false);
        seen.add(key);
      }
    }
    expect([...documented].sort()).toEqual([...seen].sort());
    expect(document.paths).toBeDefined();
  });

  it("should keep operation ids unique and every operation secure by default", async () => {
    const document = (await buildApiDocument()) as unknown as DocumentShape;
    const operationIds: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (typeof operation !== "object" || operation === null) {
          continue;
        }
        expect(operation.operationId, `${method} ${path}`).toBeTypeOf("string");
        operationIds.push(operation.operationId ?? "");
        const key = `${method.toUpperCase()} ${path}`;
        const doc = Object.entries(ROUTE_DOCS).find(([route]) => {
          const separator = route.indexOf(" ");
          const routeMethod = route.slice(0, separator);
          const routePath = route
            .slice(separator + 1)
            .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
          return (
            routeMethod === key.slice(0, key.indexOf(" ")) &&
            routePath === key.slice(key.indexOf(" ") + 1)
          );
        })?.[1];
        if (doc?.secure === true) {
          expect(operation.security, `${key} must require bearer`).toBeDefined();
        }
        if (doc?.secure === false) {
          expect(operation.security, `${key} must be public`).toBeUndefined();
        }
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("should exclude internal agent, browser, and health routes", async () => {
    const document = (await buildApiDocument()) as unknown as DocumentShape;
    const paths = Object.keys(document.paths);
    for (const forbidden of ["/v1/agent", "/v1/auth/local", "/v1/auth/callback", "/health"]) {
      expect(paths.some((path) => path.startsWith(forbidden))).toBe(false);
    }
    expect(paths).toContain("/ready");
  });

  it("should document every browser route and generate a drift-free web client", async () => {
    const document = (await buildWebApiDocument()) as unknown as DocumentShape;
    const documented = new Set(Object.keys(WEB_ROUTE_DOCS));
    const seen = new Set<string>();
    for (const registration of WEB_CONTRACT_CONTROLLERS) {
      const controller = new registration.controller({}, {});
      for (const route of controller.routes()) {
        const key = routeKey(route.method, joinPath(registration.basePath, route.path));
        expect(documented.has(key), `missing web metadata for ${key}`).toBe(true);
        expect(seen.has(key), `duplicate web route ${key}`).toBe(false);
        seen.add(key);
      }
    }
    expect([...documented].sort()).toEqual([...seen].sort());

    const paths = Object.keys(document.paths);
    expect(paths).toContain("/v1/auth/local/login");
    expect(paths).toContain("/v1/auth/me");
    expect(paths).toContain("/v1/auth/logout");
    expect(paths).toContain("/v1/meta/auth");
    expect(paths.some((path) => path.startsWith("/v1/agent"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/v1/auth/cli"))).toBe(false);

    const directory = tempDirectory();
    const outputDir = join(directory, "web-client");
    const webOutputDir = join(directory, "web-client-2");
    const contractFile = join(directory, "openapi.json");
    await generateContract({ outputDir, contractFile, webOutputDir });
    const clean = await checkContract({ outputDir, contractFile, webOutputDir });
    expect(clean.driftedFiles).toEqual([]);
    expect(clean.hasErrors).toBe(false);
  }, 30_000);

  it("should generate a clean contract and report client drift", async () => {
    const directory = tempDirectory();
    const outputDir = join(directory, "client");
    const contractFile = join(directory, "openapi.json");
    await generateContract({ outputDir, contractFile });
    expect(readFileSync(contractFile, "utf8")).toContain('"openapi": "3.1.0"');

    const clean = await checkContract({ outputDir, contractFile });
    expect(clean.driftedFiles).toEqual([]);
    expect(clean.issues.filter((issue) => issue.severity === "error")).toEqual([]);

    writeFileSync(join(outputDir, "client.auth.ts"), "// changed\n", "utf8");
    const drifted = await checkContract({ outputDir, contractFile });
    expect(drifted.driftedFiles).toContain("client.auth.ts");
  }, 30_000);

  it("should report a stale generated file that the generator would prune", async () => {
    const directory = tempDirectory();
    const outputDir = join(directory, "client");
    const contractFile = join(directory, "openapi.json");
    await generateContract({ outputDir, contractFile });
    writeFileSync(
      join(outputDir, "client.stale.ts"),
      "// Generated by `blendsdk api generate` — do not edit by hand.\nexport {};\n",
      "utf8",
    );
    const result = await checkContract({ outputDir, contractFile });
    expect(result.driftedFiles).toContain("client.stale.ts");
  }, 30_000);
});
