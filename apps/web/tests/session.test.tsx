import type { AdapterRequest } from "blendsdk/api-client";
import { describe, expect, it, vi } from "vitest";
import { CsrfCookieAuth } from "../src/session/csrf-cookie-auth.js";

function request(method: string): AdapterRequest {
  return {
    url: "https://vault.example.test/v1/test",
    method,
    headers: { accept: "application/json" },
  };
}

describe("CSRF cookie auth", () => {
  it("should add credentials and the CSRF header to unsafe methods", async () => {
    const auth = new CsrfCookieAuth({
      currentToken: () => "csrf-token",
      refresh: async () => true,
    });
    const posted = await auth.apply(request("POST"));
    expect(posted.credentials).toBe("include");
    expect(posted.headers["x-csrf-token"]).toBe("csrf-token");

    const got = await auth.apply(request("GET"));
    expect(got.credentials).toBe("include");
    expect(got.headers["x-csrf-token"]).toBeUndefined();
  });

  it("should omit the header before a session exists and refresh once", async () => {
    let token: string | null = null;
    const refresh = vi.fn(async () => {
      token = "rotated-token";
      return true;
    });
    const auth = new CsrfCookieAuth({ currentToken: () => token, refresh });
    const before = await auth.apply(request("DELETE"));
    expect(before.headers["x-csrf-token"]).toBeUndefined();
    expect(await auth.refreshOnUnauthorized()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const after = await auth.apply(request("DELETE"));
    expect(after.headers["x-csrf-token"]).toBe("rotated-token");
  });
});
