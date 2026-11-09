import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { manifestFileName, renderCompose, renderManifest } from "../src/scaffold/compose.js";

const COMPOSE_PROJECT_VAR = "$" + "{COMPOSE_PROJECT_NAME}";

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
    const otherProject = renderCompose({ project: "reports", service: "api", entries: [] });
    expect(api).toContain("openvault-agent-api");
    expect(worker).toContain("openvault-agent-worker");
    expect(api).toContain("blendsdk/openvault-agent:1.2.0");
    expect(api).not.toContain("ghcr.io");
    const agent = (
      parse(api) as {
        services: Record<string, { command?: unknown; healthcheck?: Record<string, unknown> }>;
      }
    ).services["openvault-agent-api"];
    if (agent === undefined) {
      throw new Error("the rendered agent service is missing");
    }
    expect(agent.command).toEqual(["run"]);
    expect(agent.healthcheck?.timeout).toBe("10s");
    expect(agent.healthcheck?.start_period).toBe("10s");
    expect(api).toContain(`/dev/shm/openvault/payments/${COMPOSE_PROJECT_VAR}/api`);
    expect(worker).toContain(`/dev/shm/openvault/payments/${COMPOSE_PROJECT_VAR}/worker`);
    expect(api).toContain(`openvault-state/payments/${COMPOSE_PROJECT_VAR}/api`);
    expect(worker).toContain(`openvault-state/payments/${COMPOSE_PROJECT_VAR}/worker`);
    expect(otherProject).toContain(`/dev/shm/openvault/reports/${COMPOSE_PROJECT_VAR}/api`);
    expect(otherProject).not.toContain("/dev/shm/openvault/payments/");
  });

  it("should not embed a token and should include the placement instructions", () => {
    const compose = renderCompose({ project: "payments", service: "api", entries: [] });
    expect(compose).not.toContain("token=");
    expect(compose).toContain("$" + "{OPENVAULT_JOIN_TOKEN}");
    expect(compose).toContain("Set OPENVAULT_JOIN_TOKEN");
    expect(compose).toContain("install -d -m 0700 -o 10001 -g 10001");
    expect(manifestFileName("payments", "api")).toBe(
      `openvault.${COMPOSE_PROJECT_VAR}.payments.api.manifest.yaml`,
    );
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
