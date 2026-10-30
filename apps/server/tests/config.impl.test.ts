import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  createWebApplicationConfig,
  formatCidr,
  loadConfig,
  parseCidrList,
} from "../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "./helpers/config-fixture.js";

let fixture: ConfigFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function config() {
  fixture = createConfigFixture();
  return loadConfig(fixture.env);
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
    expect(settings.BODY_LIMIT).toBe("128kb");
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
