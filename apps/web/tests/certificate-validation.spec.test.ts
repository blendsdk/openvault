import { describe, expect, it } from "vitest";
import {
  endOfDayIso,
  parseSans,
  parseSubject,
  parseValidityDays,
  startOfDayIso,
  validateCertificateName,
} from "../src/validation.js";

describe("certificate client validation", () => {
  it("should accept a certificate name that follows the secret-name allowlist", () => {
    expect(validateCertificateName("api-tls")).toBeUndefined();
    expect(validateCertificateName("A1")).toBeUndefined();
  });

  it("should reject an empty, leading-hyphen, or overlong certificate name", () => {
    expect(validateCertificateName("")).toBeDefined();
    expect(validateCertificateName("-api")).toBeDefined();
    expect(validateCertificateName("a".repeat(128))).toBeDefined();
    expect(validateCertificateName("api_tls")).toBeDefined();
  });

  it("should require an RFC 4514 subject with an equals sign", () => {
    expect(parseSubject("CN=api.example.com")).toBeUndefined();
    expect(parseSubject("CN=api.example.com, O=Payments")).toBeUndefined();
    expect(parseSubject("api.example.com")).toBeDefined();
    expect(parseSubject("")).toBeDefined();
    expect(parseSubject(`CN=${"a".repeat(1_025)}`)).toBeDefined();
    expect(parseSubject("CN=api\u0000")).toBeDefined();
  });

  it("should parse typed SAN lines and drop blank lines", () => {
    const result = parseSans("DNS:api.example.com\n\nIP:10.0.0.1\n");
    expect(result.error).toBeUndefined();
    expect(result.sans).toEqual(["DNS:api.example.com", "IP:10.0.0.1"]);
  });

  it("should reject an empty SAN list", () => {
    const result = parseSans("\n  \n");
    expect(result.sans).toEqual([]);
    expect(result.error).toBe("Add at least one SAN");
  });

  it("should reject a SAN without a typed prefix", () => {
    const result = parseSans("api.example.com");
    expect(result.error).toContain("DNS:");
    expect(result.sans).toEqual([]);
  });

  it("should reject a typed SAN with an empty value", () => {
    const result = parseSans("DNS:");
    expect(result.error).toBeDefined();
  });

  it("should reject a SAN entry with control characters", () => {
    const result = parseSans("DNS:api\u0007.example.com");
    expect(result.error).toBeDefined();
  });

  it("should accept 100 SAN entries and reject 101", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `DNS:host${index}.example.com`);
    expect(parseSans(hundred.join("\n")).error).toBeUndefined();
    const hundredAndOne = [...hundred, "DNS:extra.example.com"];
    expect(parseSans(hundredAndOne.join("\n")).error).toBeDefined();
  });

  it("should reject a SAN entry over 2,048 characters", () => {
    const result = parseSans(`DNS:${"a".repeat(2_045)}`);
    expect(result.error).toBeDefined();
  });

  it("should accept a validity between 1 and 825 days", () => {
    expect(parseValidityDays("1")).toEqual({ days: 1 });
    expect(parseValidityDays("365")).toEqual({ days: 365 });
    expect(parseValidityDays("825")).toEqual({ days: 825 });
  });

  it("should reject a validity outside 1 to 825 whole days", () => {
    for (const value of ["0", "826", "1.5", "abc", ""]) {
      const result = parseValidityDays(value);
      expect(result.error).toBeDefined();
      expect(result.days).toBe(0);
    }
  });

  it("should convert a date input to local start and end boundaries", () => {
    const start = new Date(startOfDayIso("2026-03-29"));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(2);
    expect(start.getDate()).toBe(29);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);

    const end = new Date(endOfDayIso("2026-03-29"));
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(2);
    expect(end.getDate()).toBe(29);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });

  it("should convert a leap-day date boundary", () => {
    const leap = new Date(startOfDayIso("2028-02-29"));
    expect(leap.getFullYear()).toBe(2028);
    expect(leap.getMonth()).toBe(1);
    expect(leap.getDate()).toBe(29);
  });
});
