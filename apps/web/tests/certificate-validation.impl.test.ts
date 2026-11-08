import { describe, expect, it } from "vitest";
import {
  endOfDayIso,
  parseSans,
  parseSubject,
  parseValidityDays,
  validateCertificateName,
} from "../src/validation.js";

describe("certificate validation internals", () => {
  it("should accept a 127-character certificate name and reject 128", () => {
    expect(validateCertificateName("a".repeat(127))).toBeUndefined();
    expect(validateCertificateName("a".repeat(128))).toBeDefined();
  });

  it("should accept a subject at the contract bound and reject one over it", () => {
    const atBound = `CN=${"a".repeat(1_021)}`;
    expect(atBound).toHaveLength(1_024);
    expect(parseSubject(atBound)).toBeUndefined();
    expect(parseSubject(`${atBound}a`)).toBeDefined();
  });

  it("should reject lowercase SAN prefixes", () => {
    expect(parseSans("dns:api.example.com").error).toBeDefined();
    expect(parseSans("email:ops@example.test").error).toBeUndefined();
  });

  it("should trim whitespace around SAN entries", () => {
    expect(parseSans("  DNS:api.example.com  ").sans).toEqual(["DNS:api.example.com"]);
  });

  it("should accept 100 SANs and reject 101", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `DNS:h${index}.example.test`);
    expect(parseSans(hundred.join("\n")).error).toBeUndefined();
    expect(parseSans([...hundred, "DNS:extra.example.test"].join("\n")).error).toBeDefined();
  });

  it("should accept the validity bounds and reject values outside them", () => {
    expect(parseValidityDays("1")).toEqual({ days: 1 });
    expect(parseValidityDays("825")).toEqual({ days: 825 });
    expect(parseValidityDays(" 365 ")).toEqual({ days: 365 });
    for (const value of ["0", "826", "-1", "1e2", "365.0"]) {
      expect(parseValidityDays(value).error, value).toBeDefined();
    }
  });

  it("should convert a leap day to the end of that local day", () => {
    const end = new Date(endOfDayIso("2028-02-29"));
    expect(end.getFullYear()).toBe(2028);
    expect(end.getMonth()).toBe(1);
    expect(end.getDate()).toBe(29);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });

  it("should return the original value when the date input is not a date", () => {
    expect(endOfDayIso("not-a-date")).toBe("not-a-date");
  });
});
