import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { manifestFileName, renderCompose, renderManifest } from "../src/scaffold/compose.js";

describe("scaffold renderer", () => {
  it("should quote mapping keys and keep a leading-digit service a string", () => {
    const document = parse(renderCompose({ project: "payments", service: "123", entries: [] })) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(document.services)).toContain("123");
    expect(Object.keys(document.services)).toContain("openvault-agent-123");
  });

  it("should produce distinct per-service and per-project paths", () => {
    const api = renderCompose({ project: "payments", service: "api", entries: [] });
    const worker = renderCompose({ project: "payments", service: "worker", entries: [] });
    expect(api).toContain("openvault-agent-api");
    expect(worker).toContain("openvault-agent-worker");
    expect(api).toContain("/dev/shm/openvault/${COMPOSE_PROJECT_NAME}/api");
    expect(worker).toContain("/dev/shm/openvault/${COMPOSE_PROJECT_NAME}/worker");
    expect(api).toContain("openvault-state/${COMPOSE_PROJECT_NAME}/api");
    expect(worker).toContain("openvault-state/${COMPOSE_PROJECT_NAME}/worker");
  });

  it("should not embed a token and should include the placement instructions", () => {
    const compose = renderCompose({ project: "payments", service: "api", entries: [] });
    expect(compose).not.toContain("token=");
    expect(compose).toContain("${OPENVAULT_JOIN_TOKEN}");
    expect(compose).toContain("Set OPENVAULT_JOIN_TOKEN");
    expect(compose).toContain("install -d -m 0700 -o 10001 -g 10001");
    expect(manifestFileName("api")).toBe("openvault.${COMPOSE_PROJECT_NAME}.api.manifest.yaml");
  });

  it("should render a manifest skeleton with and without entries", () => {
    const withEntries = renderManifest({
      project: "payments",
      service: "api",
      entries: ["db-password", "stripe-key"],
    });
    expect(withEntries).toContain("db-password");
    expect(withEntries).toContain("stripe-key");
    const empty = renderManifest({ project: "payments", service: "api", entries: [] });
    expect(empty).toContain("Add at least one entry");
  });
});
