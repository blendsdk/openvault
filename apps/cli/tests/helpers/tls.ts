import { createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";

/** A disposable TLS fixture for the fake vault. */
export interface TestTls {
  readonly caPem: string;
  readonly caPath: string;
  readonly certPem: string;
  readonly keyPem: string;
  cleanup(): void;
}

/** Generates one CA and server certificate. */
export async function createTestTls(): Promise<TestTls> {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-tls-"));
  const caKeys = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const serverKeys = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const now = Date.now();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    name: "CN=OpenVault CLI Test CA",
    keys: caKeys,
    serialNumber: randomBytes(16).toString("hex"),
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const server = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(16).toString("hex"),
    subject: "CN=localhost",
    issuer: ca.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
      ]),
    ],
  });
  const caPem = ca.toString("pem");
  const caPath = join(directory, "ca.pem");
  writeFileSync(caPath, caPem, { mode: 0o600 });
  chmodSync(caPath, 0o600);
  const keyDer = await globalThis.crypto.subtle.exportKey("pkcs8", serverKeys.privateKey);
  const keyObject = createPrivateKey({
    key: Buffer.from(keyDer),
    format: "der",
    type: "pkcs8",
  });
  const exported = keyObject.export({ format: "pem", type: "pkcs8" });
  return {
    caPem,
    caPath,
    certPem: server.toString("pem"),
    keyPem: typeof exported === "string" ? exported : exported.toString("utf8"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
