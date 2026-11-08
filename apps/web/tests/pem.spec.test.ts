import { describe, expect, it, vi } from "vitest";
import { downloadPem, readPemFile } from "../src/components/pem.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function pemFile(contents: string, name = "certificate.pem"): File {
  return new File([contents], name, { type: "application/x-pem-file" });
}

describe("PEM file helpers", () => {
  it("should read a local PEM file as text", async () => {
    await expect(readPemFile(pemFile(PEM), 1_024)).resolves.toBe(PEM);
  });

  it("should reject an empty file", async () => {
    await expect(readPemFile(pemFile(""), 1_024)).rejects.toThrow(/empty/i);
  });

  it("should reject a file over the byte limit", async () => {
    await expect(readPemFile(pemFile(PEM), 8)).rejects.toThrow(/large|limit/i);
  });

  it("should reject a file without a PEM marker", async () => {
    await expect(readPemFile(pemFile("not a certificate"), 1_024)).rejects.toThrow(/PEM/i);
  });

  it("should download text as a named file and revoke the object URL", () => {
    const createObjectUrl = vi.fn(() => "blob:openvault-test");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");

    downloadPem("api-tls-certificate.pem", PEM);

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:openvault-test");
    expect(clipboard).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
