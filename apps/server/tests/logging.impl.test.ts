import { describe, expect, it } from "vitest";
import { sanitizeLogArgs, sanitizeLogMessage } from "../src/observability/logger.js";

describe("log sanitizer implementation", () => {
  it("should strip only the first query segment and preserve the rest", () => {
    expect(sanitizeLogMessage("POST /v1/auth/callback?code=a?b=c 400 2ms")).toBe(
      "POST /v1/auth/callback 400 2ms",
    );
  });

  it("should keep a URL without a query unchanged", () => {
    expect(sanitizeLogMessage("GET /v1/auth/me 200 1ms")).toBe("GET /v1/auth/me 200 1ms");
  });

  it("should not rewrite a lowercase or malformed request line", () => {
    for (const message of [
      "get /v1/auth/callback?code=a 200 1ms",
      "GET /v1/auth/callback?code=a",
      "GET  /v1/auth/callback?code=a 200 1ms",
    ]) {
      expect(sanitizeLogMessage(message)).toBe(message);
    }
  });

  it("should leave an object without a string url unchanged by identity", () => {
    const input = { url: 42, path: "/v1/auth/me" };
    const output = sanitizeLogArgs([input]);

    expect(output[0]).toBe(input);
  });

  it("should copy an object with a url instead of mutating it", () => {
    const input = { url: "/callback?code=a", status: 200 };
    const output = sanitizeLogArgs([input]);

    expect(output[0]).toEqual({ url: "/callback", status: 200 });
    expect(input.url).toBe("/callback?code=a");
  });

  it("should keep arrays and nested objects untouched", () => {
    const nested = { inner: { url: "/callback?code=a" } };
    const array = ["/callback?code=a"];
    const output = sanitizeLogArgs([nested, array]);

    expect(output[0]).toBe(nested);
    expect(output[1]).toBe(array);
  });

  it("should return a new array even when no argument changes", () => {
    const args = [42, null, true];
    const output = sanitizeLogArgs(args);

    expect(output).toEqual(args);
    expect(output).not.toBe(args);
  });
});
