import type { AgentCertificateResponse } from "@openvault/api-contract";
import { describe, expect, it } from "vitest";
import { RenewalReplayCache } from "../../src/agent/agent-renew-service.js";

function response(serial: string): AgentCertificateResponse {
  return {
    certificatePem: `certificate-${serial}`,
    chainPem: "chain",
    identityId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    serial,
    notAfter: "2027-01-01T00:00:00.000Z",
  };
}

describe("renewal replay cache", () => {
  it("should return a cached response until the five-minute window closes", () => {
    let now = 1_000;
    const cache = new RenewalReplayCache({ now: () => now });
    cache.set("p1", "hash-a", response("01"));

    expect(cache.get("p1", "hash-a")).toEqual(response("01"));
    now += 5 * 60_000 - 1;
    expect(cache.get("p1", "hash-a")).toEqual(response("01"));
    now += 1;
    expect(cache.get("p1", "hash-a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("should key by principal and public-key hash", () => {
    const cache = new RenewalReplayCache();
    cache.set("p1", "hash-a", response("01"));
    cache.set("p2", "hash-a", response("02"));
    cache.set("p1", "hash-b", response("03"));

    expect(cache.get("p1", "hash-a")?.serial).toBe("01");
    expect(cache.get("p2", "hash-a")?.serial).toBe("02");
    expect(cache.get("p1", "hash-b")?.serial).toBe("03");
    expect(cache.get("p3", "hash-a")).toBeUndefined();
  });

  it("should evict the oldest entry at the bound", () => {
    const cache = new RenewalReplayCache({ limit: 2 });
    cache.set("p1", "a", response("01"));
    cache.set("p2", "b", response("02"));
    cache.set("p3", "c", response("03"));

    expect(cache.size).toBe(2);
    expect(cache.get("p1", "a")).toBeUndefined();
    expect(cache.get("p2", "b")?.serial).toBe("02");
    expect(cache.get("p3", "c")?.serial).toBe("03");
  });

  it("should invalidate one principal without touching another", () => {
    const cache = new RenewalReplayCache();
    cache.set("p1", "a", response("01"));
    cache.set("p1", "b", response("02"));
    cache.set("p2", "a", response("03"));

    cache.invalidatePrincipal("p1");
    expect(cache.get("p1", "a")).toBeUndefined();
    expect(cache.get("p1", "b")).toBeUndefined();
    expect(cache.get("p2", "a")?.serial).toBe("03");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
