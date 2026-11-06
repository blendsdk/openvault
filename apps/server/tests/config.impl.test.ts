import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  createWebApplicationConfig,
  formatCidr,
  loadConfig,
  parseCidrList,
} from "../src/config/index.js";
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

function config() {
  fixture = createConfigFixture();
  return loadConfig(fixture.env);
}

/** Returns the fixture created by the current test. */
function currentFixture(): ConfigFixture {
  if (fixture === undefined) {
    throw new Error("fixture is not initialized");
  }
  return fixture;
}

describe("WebAFX settings bridge", () => {
  it("passes only the six standard settings", () => {
    const settings = createWebApplicationConfig(config());

    expect(Object.keys(settings).sort()).toEqual([
      "BODY_LIMIT",
      "CORS",
      "ENV_MODE",
      "LOG_LEVEL",
      "PORT",
      "TRUST_PROXY",
    ]);
    expect(settings.CORS).toBe(false);
    expect(settings.TRUST_PROXY).toBe(false);
    expect(settings.BODY_LIMIT).toBe("1mb");
  });
});

describe("file-backed database URLs", () => {
  it("reads a Docker-style readonly secret file", () => {
    fixture = createConfigFixture();
    const current = currentFixture();
    const path = writeFixtureFile(
      current.directory,
      "db-url",
      "postgres://openvault_app:secret@localhost:5432/openvault\n",
      0o444,
    );
    delete current.env.OPENVAULT_DB_URL;
    current.env.OPENVAULT_DB_URL_FILE = path;

    const config = loadConfig(current.env);

    expect(config.databaseUrl).toContain("openvault_app");
    expect(config.database.user).toBe("openvault_app");
    expect(config.database.database).toBe("openvault");
  });

  it("rejects direct and file forms together", () => {
    fixture = createConfigFixture();
    const current = currentFixture();
    const path = writeFixtureFile(
      current.directory,
      "db-url",
      "postgres://openvault_app:secret@localhost:5432/openvault\n",
      0o444,
    );
    current.env.OPENVAULT_DB_URL_FILE = path;

    expect(() => loadConfig(current.env)).toThrowError(/cannot both be set/);
  });

  it("rejects a group-writable secret file", () => {
    fixture = createConfigFixture();
    const current = currentFixture();
    const path = writeFixtureFile(
      current.directory,
      "db-url",
      "postgres://openvault_app:secret@localhost:5432/openvault\n",
      0o620,
    );
    chmodSync(path, 0o620);
    delete current.env.OPENVAULT_DB_URL;
    current.env.OPENVAULT_DB_URL_FILE = path;

    expect(() => loadConfig(current.env)).toThrowError(/group- or world-writable/);
  });

  it("accepts a migrator URL on the same database and rejects another target", () => {
    fixture = createConfigFixture();
    const current = currentFixture();
    current.env.OPENVAULT_MIGRATION_DB_URL =
      "postgres://openvault_migrator:secret@localhost:5432/openvault";

    expect(loadConfig(current.env).migrationDatabaseUrl).toContain("openvault_migrator");

    current.env.OPENVAULT_MIGRATION_DB_URL =
      "postgres://openvault_migrator:secret@localhost:5432/other";
    expect(() => loadConfig(current.env)).toThrowError(/same database/);
  });
});

describe("CIDR internals", () => {
  it("normalises an IPv4-mapped address", () => {
    const cidrs = parseCidrList("::ffff:127.0.0.1/128");
    const cidr = cidrs[0];

    expect(cidrs).toHaveLength(1);
    expect(cidr).toEqual({ address: "::ffff:7f00:1", prefix: 128, family: "ipv6" });
    if (!cidr) {
      throw new Error("expected one CIDR");
    }
    expect(formatCidr(cidr)).toBe("::ffff:7f00:1/128");
  });

  it("rejects a zone identifier", () => {
    expect(() => parseCidrList("fe80::1%eth0/64")).toThrow(ConfigError);
  });

  it("rejects an address whose host bits are set", () => {
    expect(() => parseCidrList("::ffff:127.0.0.1/120")).toThrow(ConfigError);
  });
});
