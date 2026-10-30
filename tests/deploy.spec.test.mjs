import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composePath = fileURLToPath(new URL("../deploy/compose/compose.yaml", import.meta.url));
const caddyPath = fileURLToPath(new URL("../deploy/compose/Caddyfile", import.meta.url));

function readCompose() {
  return parse(readFileSync(composePath, "utf8"));
}

function environmentOf(service) {
  const environment = service?.environment ?? {};
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, String(value)]),
  );
}

function publishedPorts(service) {
  return (service?.ports ?? []).map((entry) => String(entry));
}

describe("deployment contract", () => {
  it("places the proxy and server on a dedicated admin network", () => {
    const compose = readCompose();

    expect(compose.networks.admin_net).toBeTruthy();
    expect(compose.networks.admin_net.ipam.config[0].subnet).toBe("172.30.0.0/24");
    expect(compose.services.proxy.networks.admin_net.ipv4_address).toBe("172.30.0.2");
    expect(compose.services.openvaultd.networks.admin_net.ipv4_address).toBe("172.30.0.3");
    expect(compose.services.proxy.networks.vault_net).toBeUndefined();
  });

  it("passes the required transport and proxy environment", () => {
    const compose = readCompose();
    const environment = environmentOf(compose.services.openvaultd);

    expect(environment.OPENVAULT_ADMIN_PORT).toBe("8443");
    expect(environment.OPENVAULT_AGENT_PORT).toBe("8444");
    expect(environment.OPENVAULT_INTERNAL_CA).toBe("/etc/openvault/tls/ca.pem");
    expect(environment.OPENVAULT_TRUST_PROXY).toBe("true");
    expect(environment.OPENVAULT_PROXY_CIDRS).toBe("172.30.0.2/32");
    expect(environment.OPENVAULT_LOG_LEVEL).toBe("info");
  });

  it("never publishes the admin or agent port on the host", () => {
    const compose = readCompose();
    for (const service of Object.values(compose.services)) {
      const ports = publishedPorts(service);
      expect(ports.some((entry) => entry.includes("8443"))).toBe(false);
      expect(ports.some((entry) => entry.includes("8444"))).toBe(false);
    }
  });

  it("healthchecks the admin listener over TLS from loopback", () => {
    const compose = readCompose();
    const healthcheck = compose.services.openvaultd.healthcheck;

    expect(healthcheck).toBeTruthy();
    expect(JSON.stringify(healthcheck.test)).toContain("https://127.0.0.1:8443/health");
  });

  it("adds HSTS and timeout layers to Caddy", () => {
    const caddy = readFileSync(caddyPath, "utf8");

    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(caddy).toContain("servers {");
    expect(caddy).toContain("read_header 10s");
    expect(caddy).toContain("read_body 30s");
    expect(caddy).toContain("write 30s");
    expect(caddy).toContain("idle 120s");
    expect(caddy).toContain("read_timeout 30s");
    expect(caddy).toContain("write_timeout 30s");
    expect(caddy).toContain("keepalive 10s");
    expect(caddy).not.toContain("idle_timeout");
  });

  it("passes caddy validate when Caddy is installed", () => {
    const result = spawnSync("caddy", ["validate", "--config", caddyPath], {
      encoding: "utf8",
    });
    if (result.error?.code === "ENOENT") {
      return;
    }
    expect(result.status, result.stderr).toBe(0);
  });
});
