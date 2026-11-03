import { describe, expect, it } from "vitest";
import { CsrValidationError, parseAgentCsr, x509 } from "../../src/security/x509.js";
import { createAgentCsr } from "../integration/helpers/agent-tls.js";

describe("CSR resource and encoding boundaries", () => {
  it("should reject empty and oversized envelopes before ASN.1 parsing", async () => {
    await expect(parseAgentCsr("")).rejects.toMatchObject({ reason: "malformed" });
    await expect(parseAgentCsr("a".repeat(65_537))).rejects.toMatchObject({
      reason: "malformed",
    });
  });

  it("should accept the exact 65,536-character envelope boundary only when it parses", async () => {
    const oversizedButBounded = `${"a".repeat(65_536)}`;
    await expect(parseAgentCsr(oversizedButBounded)).rejects.toBeInstanceOf(CsrValidationError);
  });

  it("should accept a CSR with no extensions", async () => {
    const csr = await createAgentCsr({ extensions: [] });
    await expect(parseAgentCsr(csr.csrPem)).resolves.toMatchObject({
      publicKeySha256: csr.publicKeySha256,
    });
  });

  it("should reject a CSR carrying a key-usage extension", async () => {
    const csr = await createAgentCsr({
      extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature)],
    });
    await expect(parseAgentCsr(csr.csrPem)).rejects.toMatchObject({
      reason: "extensions_not_allowed",
    });
  });

  it("should reject a second extensionRequest attribute", async () => {
    const csr = await createAgentCsr({
      attributes: [
        new x509.ExtensionsAttribute([]),
        new x509.ExtensionsAttribute([
          new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "evil.test" }]),
        ]),
      ],
    });
    await expect(parseAgentCsr(csr.csrPem)).rejects.toMatchObject({
      reason: "extensions_not_allowed",
    });
  });

  it("should map a malformed extensionRequest attribute to a validation error", async () => {
    const csr = await createAgentCsr({
      attributes: [new x509.Attribute("1.2.840.113549.1.9.14", [Buffer.from("3003010100", "hex")])],
    });
    await expect(parseAgentCsr(csr.csrPem)).rejects.toBeInstanceOf(CsrValidationError);
  });

  it("should ignore a complex but valid subject", async () => {
    const csr = await createAgentCsr({ subject: "CN=agent,O=Example,C=US" });
    const parsed = await parseAgentCsr(csr.csrPem);
    expect(parsed.publicKeySha256).toHaveLength(64);
  });
});
