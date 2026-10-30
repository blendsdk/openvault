import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, toRedactedConfig } from "../src/config/index.js";
import {
  type ConfigFixture,
  createConfigFixture,
  writeFixtureFile,
} from "./helpers/config-fixture.js";

let fixture: ConfigFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function validFixture(): ConfigFixture {
  fixture = createConfigFixture();
  return fixture;
}

function requireConfigError(action: () => unknown): ConfigError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected ConfigError");
}

describe("required base URL", () => {
  it("names OPENVAULT_BASE_URL when the environment is empty", () => {
    const error = requireConfigError(() => loadConfig({}));

    expect(error.key).toBe("OPENVAULT_BASE_URL");
    expect(error.message).not.toContain("undefined");
  });

  it("does not mutate the supplied environment", () => {
    const env = { ...validFixture().env };

    loadConfig(env);

    expect(env).toEqual(fixture?.env);
  });
});

describe("database URL", () => {
  it("rejects a non-PostgreSQL scheme without echoing the password", () => {
    const { env } = validFixture();
    const error = requireConfigError(() =>
      loadConfig({ ...env, OPENVAULT_DB_URL: "mysql://user:db-password@db/openvault" }),
    );

    expect(error.key).toBe("OPENVAULT_DB_URL");
    expect(error.message).not.toContain("db-password");
  });

  it("rejects a URL without a database or user", () => {
    const { env } = validFixture();

    expect(
      requireConfigError(() =>
        loadConfig({ ...env, OPENVAULT_DB_URL: "postgres://user:secret@db:5432/" }),
      ).key,
    ).toBe("OPENVAULT_DB_URL");
    expect(
      requireConfigError(() =>
        loadConfig({ ...env, OPENVAULT_DB_URL: "postgres://db:5432/openvault" }),
      ).key,
    ).toBe("OPENVAULT_DB_URL");
  });
});

describe("base URL", () => {
  it("rejects a non-HTTPS URL, credentials, a query, and a fragment", () => {
    const { env } = validFixture();
    const invalid = [
      "http://vault.example.com",
      "https://user:pass@vault.example.com",
      "https://vault.example.com/?token=secret",
      "https://vault.example.com/#fragment",
    ];

    for (const value of invalid) {
      const error = requireConfigError(() => loadConfig({ ...env, OPENVAULT_BASE_URL: value }));
      expect(error.key).toBe("OPENVAULT_BASE_URL");
      expect(error.message).not.toContain("pass");
    }
  });

  it("keeps a path and removes one trailing slash", () => {
    const { env } = validFixture();
    const config = loadConfig({ ...env, OPENVAULT_BASE_URL: "https://vault.example.com/vault/" });

    expect(config.baseUrl.href).toBe("https://vault.example.com/vault");
  });
});

describe("keyring permissions", () => {
  it("rejects a group- or world-readable keyring file", () => {
    const { env, directory } = validFixture();
    const worldReadable = writeFixtureFile(directory, "keyring-0644.json", "{}", 0o644);

    const error = requireConfigError(() =>
      loadConfig({ ...env, OPENVAULT_KEYRING: worldReadable }),
    );

    expect(error.key).toBe("OPENVAULT_KEYRING");
    expect(error.message).toMatch(/0600|permission|mode/i);
  });

  it("rejects a relative keyring path", () => {
    const { env } = validFixture();

    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_KEYRING: "keyring.json" })).key,
    ).toBe("OPENVAULT_KEYRING");
  });
});

describe("required TLS material", () => {
  it("names each missing TLS file", () => {
    const { env } = validFixture();
    for (const key of ["OPENVAULT_TLS_CERT", "OPENVAULT_TLS_KEY", "OPENVAULT_INTERNAL_CA"]) {
      const error = requireConfigError(() =>
        loadConfig({ ...env, [key]: join(fixture?.directory ?? "/tmp", "missing.pem") }),
      );
      expect(error.key).toBe(key);
    }
  });

  it("rejects a directory used as a TLS file", () => {
    const { env, directory } = validFixture();

    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_TLS_CERT: directory })).key,
    ).toBe("OPENVAULT_TLS_CERT");
  });
});

describe("OIDC configuration", () => {
  it("requires client credentials when an issuer is set", () => {
    const { env } = validFixture();
    const withIssuer = { ...env, OPENVAULT_OIDC_ISSUER: "https://id.example.com" };

    expect(requireConfigError(() => loadConfig(withIssuer)).key).toBe("OPENVAULT_OIDC_CLIENT_ID");
    expect(
      requireConfigError(() => loadConfig({ ...withIssuer, OPENVAULT_OIDC_CLIENT_ID: "client" }))
        .key,
    ).toBe("OPENVAULT_OIDC_CLIENT_SECRET");
  });

  it("rejects dependent OIDC values without an issuer", () => {
    const { env } = validFixture();

    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_OIDC_CLIENT_ID: "client" })).key,
    ).toBe("OPENVAULT_OIDC_ISSUER");
    expect(
      requireConfigError(() =>
        loadConfig({ ...env, OPENVAULT_OIDC_ALLOWED_DOMAINS: "example.com" }),
      ).key,
    ).toBe("OPENVAULT_OIDC_ISSUER");
  });

  it("defaults the redirect URL from the base URL", () => {
    const { env } = validFixture();
    const config = loadConfig({
      ...env,
      OPENVAULT_OIDC_ISSUER: "https://id.example.com",
      OPENVAULT_OIDC_CLIENT_ID: "client",
      OPENVAULT_OIDC_CLIENT_SECRET: "oidc-secret",
      OPENVAULT_OIDC_ALLOWED_DOMAINS: "example.com, sub.example.com",
    });

    expect(config.oidc?.redirectUrl.href).toBe("https://vault.example.com/v1/auth/callback");
    expect(config.oidc?.allowedDomains).toEqual(["example.com", "sub.example.com"]);
  });

  it("rejects an invalid redirect URL or domain label", () => {
    const { env } = validFixture();
    const complete = {
      ...env,
      OPENVAULT_OIDC_ISSUER: "https://id.example.com",
      OPENVAULT_OIDC_CLIENT_ID: "client",
      OPENVAULT_OIDC_CLIENT_SECRET: "oidc-secret",
    };

    expect(
      requireConfigError(() =>
        loadConfig({ ...complete, OPENVAULT_OIDC_REDIRECT_URL: "http://vault.example.com/cb" }),
      ).key,
    ).toBe("OPENVAULT_OIDC_REDIRECT_URL");
    expect(
      requireConfigError(() =>
        loadConfig({ ...complete, OPENVAULT_OIDC_ALLOWED_DOMAINS: "-bad.example.com" }),
      ).key,
    ).toBe("OPENVAULT_OIDC_ALLOWED_DOMAINS");
  });
});

describe("redacted support output", () => {
  it("omits the database password, OIDC secret, and raw database URL", () => {
    const { env } = validFixture();
    const config = loadConfig({
      ...env,
      OPENVAULT_OIDC_ISSUER: "https://id.example.com",
      OPENVAULT_OIDC_CLIENT_ID: "client",
      OPENVAULT_OIDC_CLIENT_SECRET: "oidc-secret",
    });

    const redacted = JSON.stringify(toRedactedConfig(config));

    expect(redacted).not.toContain("db-password");
    expect(redacted).not.toContain("oidc-secret");
    expect(redacted).not.toContain("databaseUrl");
    expect(redacted).toContain('"pass":"***"');
    expect(redacted).toContain('"clientSecret":"***"');
    expect(redacted).toContain(env.OPENVAULT_KEYRING);
    expect(redacted).toContain(env.OPENVAULT_TLS_CERT);
  });
});

describe("port precedence", () => {
  it("fails when OPENVAULT_ADMIN_PORT and PORT differ", () => {
    const { env } = validFixture();
    const error = requireConfigError(() =>
      loadConfig({ ...env, OPENVAULT_ADMIN_PORT: "9443", PORT: "8443" }),
    );

    expect(error.key).toBe("OPENVAULT_ADMIN_PORT");
    expect(error.message).toContain("PORT");
  });

  it("accepts PORT as a compatibility alias", () => {
    const { env } = validFixture();

    expect(loadConfig({ ...env, PORT: "9443" }).adminPort).toBe(9443);
  });

  it("prefers OPENVAULT_ADMIN_PORT", () => {
    const { env } = validFixture();

    expect(loadConfig({ ...env, OPENVAULT_ADMIN_PORT: "9443" }).adminPort).toBe(9443);
  });

  it("defaults the agent port and rejects an admin collision", () => {
    const { env } = validFixture();
    const defaults = loadConfig({ ...env });

    expect(defaults.adminPort).toBe(8443);
    expect(defaults.agentPort).toBe(8444);

    const error = requireConfigError(() => loadConfig({ ...env, OPENVAULT_AGENT_PORT: "8443" }));
    expect(error.key).toBe("OPENVAULT_AGENT_PORT");
    expect(error.message).toContain("OPENVAULT_ADMIN_PORT");
  });
});

describe("CIDR list parsing", () => {
  it("parses IPv4 and IPv6 entries", () => {
    const { env } = validFixture();
    const config = loadConfig({
      ...env,
      OPENVAULT_PROXY_CIDRS: "172.30.0.2/32, 2001:db8::/32",
    });

    expect(config.proxyCidrs).toEqual([
      { address: "172.30.0.2", prefix: 32, family: "ipv4" },
      { address: "2001:db8::", prefix: 32, family: "ipv6" },
    ]);
  });

  it("rejects malformed entries and empty list items", () => {
    const { env } = validFixture();
    for (const value of ["not-a-cidr", "172.30.0.2/33", "172.30.0.2/32,,10.0.0.0/8", ""]) {
      const error = requireConfigError(() => loadConfig({ ...env, OPENVAULT_PROXY_CIDRS: value }));
      expect(error.key).toBe("OPENVAULT_PROXY_CIDRS");
    }
  });

  it("rejects a network address with host bits set", () => {
    const { env } = validFixture();

    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_PROXY_CIDRS: "172.30.0.9/24" })).key,
    ).toBe("OPENVAULT_PROXY_CIDRS");
  });
});

describe("configuration defaults", () => {
  it("applies the documented defaults", () => {
    const { env } = validFixture();
    const config = loadConfig(env);

    expect(config.envMode).toBe("production");
    expect(config.trustProxy).toBe(true);
    expect(config.logLevel).toBe("info");
    expect(config.secretMaxBytes).toBe(65_536);
    expect(config.certMaxBytes).toBe(131_072);
    expect(config.softDeleteDays).toBe(30);
    expect(config.auditRetentionDays).toBe(180);
    expect(config.joinTokenTtlMs).toBe(15 * 60_000);
    expect(config.certTtlDays).toBe(30);
    expect(config.sessionTtlHours).toBe(8);
  });

  it("rejects invalid ENV_MODE and invalid numeric bounds", () => {
    const { env } = validFixture();

    expect(requireConfigError(() => loadConfig({ ...env, ENV_MODE: "staging" })).key).toBe(
      "ENV_MODE",
    );
    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_SECRET_MAX_BYTES: "10" })).key,
    ).toBe("OPENVAULT_SECRET_MAX_BYTES");
    expect(
      requireConfigError(() => loadConfig({ ...env, OPENVAULT_JOIN_TOKEN_TTL: "25h" })).key,
    ).toBe("OPENVAULT_JOIN_TOKEN_TTL");
  });

  it("fails closed when the keyring passphrase file is set", () => {
    const { env, directory } = validFixture();
    const passphrase = writeFixtureFile(directory, "passphrase", "secret", 0o600);

    const error = requireConfigError(() =>
      loadConfig({ ...env, OPENVAULT_KEYRING_PASSPHRASE_FILE: passphrase }),
    );

    expect(error.key).toBe("OPENVAULT_KEYRING_PASSPHRASE_FILE");
    expect(error.message).toMatch(/age|deferred|unsupported/i);
  });
});

describe("configuration file checks", () => {
  it("rejects an unreadable TLS file role", () => {
    const { env, directory } = validFixture();
    const missing = join(directory, "does-not-exist.pem");
    writeFileSync(join(directory, "placeholder"), "");

    expect(requireConfigError(() => loadConfig({ ...env, OPENVAULT_TLS_KEY: missing })).key).toBe(
      "OPENVAULT_TLS_KEY",
    );
  });
});
