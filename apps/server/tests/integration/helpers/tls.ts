import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PEM material and file paths generated for one transport test. */
export interface TlsFixture {
  /** Temporary directory that owns every file. */
  readonly directory: string;
  /** Trusted CA certificate path and PEM. */
  readonly caPath: string;
  readonly caPem: string;
  /** Server certificate and key signed by the trusted CA. */
  readonly serverCertPath: string;
  readonly serverKeyPath: string;
  readonly serverCertPem: string;
  readonly serverKeyPem: string;
  /** Client certificate and key signed by the trusted CA. */
  readonly clientCertPath: string;
  readonly clientKeyPath: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  /** Client certificate signed by a different CA. */
  readonly wrongClientCertPath: string;
  readonly wrongClientKeyPath: string;
  readonly wrongClientCertPem: string;
  readonly wrongClientKeyPem: string;
  /** A second private key that does not match the server certificate. */
  readonly mismatchedKeyPath: string;
  /** A non-CA leaf certificate that must not be accepted as a trust anchor. */
  readonly leafOnlyCertPath: string;
  cleanup(): void;
}

function runOpenSsl(args: readonly string[]): void {
  const result = spawnSync("openssl", [...args], { encoding: "utf8" });
  if (result.error) {
    throw new Error("OpenSSL is required for transport tests. Install it and rerun the suite.", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`OpenSSL command failed: ${args[0]}\n${result.stderr}`);
  }
}

function write(path: string, contents: string, mode = 0o600): string {
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

/**
 * Generates a disposable CA, server certificate, valid client certificate, and
 * an untrusted client certificate with the system OpenSSL binary.
 *
 * No private key is written into the repository. The caller must invoke
 * {@link TlsFixture.cleanup} in a `finally` block.
 *
 * @returns Paths and PEM contents for transport and TLS-material tests.
 *
 * @example
 * ```ts
 * const tls = createTlsFixture();
 * try {
 *   // use tls.caPath, tls.serverCertPath, ...
 * } finally {
 *   tls.cleanup();
 * }
 * ```
 */
export function createTlsFixture(): TlsFixture {
  const directory = mkdtempSync(join(tmpdir(), "openvault-tls-"));

  const caKey = join(directory, "ca.key");
  const caPath = join(directory, "ca.pem");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCert = join(directory, "server.pem");
  const clientKey = join(directory, "client.key");
  const clientCsr = join(directory, "client.csr");
  const clientCert = join(directory, "client.pem");
  const wrongCaKey = join(directory, "wrong-ca.key");
  const wrongCaPath = join(directory, "wrong-ca.pem");
  const wrongClientKey = join(directory, "wrong-client.key");
  const wrongClientCsr = join(directory, "wrong-client.csr");
  const wrongClientCert = join(directory, "wrong-client.pem");
  const mismatchedKey = join(directory, "mismatched.key");

  const serverExt = join(directory, "server.ext");
  const clientExt = join(directory, "client.ext");

  runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caPath,
    "-days",
    "1",
    "-subj",
    "/CN=OpenVault Test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKey,
    "-out",
    serverCsr,
    "-subj",
    "/CN=localhost",
  ]);
  write(serverExt, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    serverCsr,
    "-CA",
    caPath,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    serverCert,
    "-days",
    "1",
    "-extfile",
    serverExt,
  ]);

  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    clientKey,
    "-out",
    clientCsr,
    "-subj",
    "/CN=openvault-test-agent",
  ]);
  write(clientExt, "extendedKeyUsage=clientAuth\n");
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    clientCsr,
    "-CA",
    caPath,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    clientCert,
    "-days",
    "1",
    "-extfile",
    clientExt,
  ]);

  runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    wrongCaKey,
    "-out",
    wrongCaPath,
    "-days",
    "1",
    "-subj",
    "/CN=OpenVault Wrong CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    wrongClientKey,
    "-out",
    wrongClientCsr,
    "-subj",
    "/CN=openvault-wrong-agent",
  ]);
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    wrongClientCsr,
    "-CA",
    wrongCaPath,
    "-CAkey",
    wrongCaKey,
    "-CAcreateserial",
    "-out",
    wrongClientCert,
    "-days",
    "1",
    "-extfile",
    clientExt,
  ]);

  runOpenSsl(["genrsa", "-out", mismatchedKey, "2048"]);
  chmodSync(mismatchedKey, 0o600);

  const caPem = readFileSync(caPath, "utf8");
  const serverCertPem = readFileSync(serverCert, "utf8");
  const serverKeyPem = readFileSync(serverKey, "utf8");
  const clientCertPem = readFileSync(clientCert, "utf8");
  const clientKeyPem = readFileSync(clientKey, "utf8");
  const wrongClientCertPem = readFileSync(wrongClientCert, "utf8");
  const wrongClientKeyPem = readFileSync(wrongClientKey, "utf8");

  return {
    directory,
    caPath,
    caPem,
    serverCertPath: serverCert,
    serverKeyPath: serverKey,
    serverCertPem,
    serverKeyPem,
    clientCertPath: clientCert,
    clientKeyPath: clientKey,
    clientCertPem,
    clientKeyPem,
    wrongClientCertPath: wrongClientCert,
    wrongClientKeyPath: wrongClientKey,
    wrongClientCertPem,
    wrongClientKeyPem,
    mismatchedKeyPath: mismatchedKey,
    leafOnlyCertPath: serverCert,
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
