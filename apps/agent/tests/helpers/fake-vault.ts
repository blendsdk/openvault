import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import * as x509 from "@peculiar/x509";

const DAY_MS = 86_400_000;
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly authorized: boolean;
}

/** A fault returned by the fake vault. */
export interface FakeFault {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
  /** Destroy the socket instead of responding. */
  readonly drop?: boolean;
}

/** Options for the fake vault. */
export interface FakeVaultOptions {
  /** Token accepted by join. */
  readonly joinToken?: string;
  /** Certificate lifetime in days. */
  readonly ttlDays?: number;
}

/** A disposable fake agent listener. */
export interface FakeVault {
  readonly url: URL;
  readonly caPath: string;
  readonly caPem: string;
  readonly requests: RecordedRequest[];
  readonly values: Map<string, { value: string; encoding: "utf8" | "base64" }>;
  readonly faults: Map<string, FakeFault>;
  readonly issuedPublicKeys: string[];
  readonly heartbeats: string[];
  close(): Promise<void>;
}

/** Generates an EC P-256 pair. */
async function keys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

/** Exports a private key as PKCS#8 PEM. */
async function keyPem(pair: CryptoKeyPair): Promise<string> {
  const der = await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const object = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  const exported = object.export({ format: "pem", type: "pkcs8" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

/** Returns a SHA-256 hex digest. */
function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Reads a request body. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Sends a JSON response in the same envelope the real server uses. */
function send(response: ServerResponse, status: number, value: unknown): void {
  const payload = status >= 200 && status < 300 ? { success: true, data: value } : value;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** Builds an error envelope. */
function errorBody(code: string, message: string): unknown {
  return { success: false, error: { code, message, statusCode: 400 } };
}

/**
 * Starts a real HTTPS fake vault with a generated CA.
 *
 * @param options - Token and certificate lifetime.
 * @returns The running fake and its CA path.
 */
export async function startFakeVault(options: FakeVaultOptions = {}): Promise<FakeVault> {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-fake-"));
  const caKeys = await keys();
  const serverKeys = await keys();
  const now = Date.now();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    name: "CN=OpenVault Fake CA",
    keys: caKeys,
    serialNumber: randomBytes(16).toString("hex"),
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 365 * DAY_MS),
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
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 365 * DAY_MS),
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

  const requests: RecordedRequest[] = [];
  const values = new Map<string, { value: string; encoding: "utf8" | "base64" }>();
  const faults = new Map<string, FakeFault>();
  const issuedPublicKeys: string[] = [];
  const heartbeats: string[] = [];
  const joinToken = options.joinToken ?? "A".repeat(43);
  const ttlDays = options.ttlDays ?? 30;

  const httpsServer = createServer(
    {
      key: await keyPem(serverKeys),
      cert: server.toString("pem"),
      ca: caPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    },
    async (request, response) => {
      const url = new URL(request.url ?? "/", "https://localhost");
      const raw = await bodyOf(request);
      let body: unknown;
      try {
        body = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
      } catch {
        body = raw;
      }
      const authorized = (request.socket as TLSSocket).authorized === true;
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        headers: request.headers,
        body,
        authorized,
      });

      const fault = faults.get(`${request.method ?? ""} ${url.pathname}`);
      if (fault !== undefined) {
        if (fault.drop === true) {
          request.socket.destroy();
          return;
        }
        send(
          response,
          fault.status,
          errorBody(fault.code ?? "injected", fault.message ?? "Injected"),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/agent/join") {
        const parsed = body as { token?: string; csr?: string } | undefined;
        if (parsed?.token !== joinToken) {
          send(response, 401, errorBody("join_failed", "Join failed"));
          return;
        }
        if (typeof parsed.csr !== "string") {
          send(response, 422, errorBody("validation_error", "Validation failed"));
          return;
        }
        let csr: x509.Pkcs10CertificateRequest;
        try {
          csr = new x509.Pkcs10CertificateRequest(parsed.csr);
        } catch {
          send(response, 422, errorBody("validation_error", "Validation failed"));
          return;
        }
        const spki = Buffer.from(csr.publicKey.rawData);
        issuedPublicKeys.push(sha256Hex(spki));
        const certificate = await x509.X509CertificateGenerator.create({
          serialNumber: randomBytes(8).toString("hex"),
          subject: csr.subject,
          issuer: ca.subject,
          notBefore: new Date(Date.now() - 60_000),
          notAfter: new Date(Date.now() + ttlDays * DAY_MS),
          publicKey: csr.publicKey,
          signingKey: caKeys.privateKey,
          extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.2"], false),
          ],
        });
        send(response, 200, {
          certificatePem: certificate.toString("pem"),
          chainPem: caPem,
          identityId: ULID,
          serial: certificate.serialNumber,
          notAfter: new Date(Date.now() + ttlDays * DAY_MS).toISOString(),
        });
        return;
      }

      if (!authorized) {
        send(response, 401, errorBody("authentication_required", "Authentication required"));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/agent/renew") {
        const parsed = body as { csr?: string } | undefined;
        if (typeof parsed?.csr !== "string") {
          send(response, 422, errorBody("validation_error", "Validation failed"));
          return;
        }
        const csr = new x509.Pkcs10CertificateRequest(parsed.csr);
        issuedPublicKeys.push(sha256Hex(Buffer.from(csr.publicKey.rawData)));
        const certificate = await x509.X509CertificateGenerator.create({
          serialNumber: randomBytes(8).toString("hex"),
          subject: csr.subject,
          issuer: ca.subject,
          notBefore: new Date(Date.now() - 60_000),
          notAfter: new Date(Date.now() + ttlDays * DAY_MS),
          publicKey: csr.publicKey,
          signingKey: caKeys.privateKey,
          extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.2"], false),
          ],
        });
        send(response, 200, {
          certificatePem: certificate.toString("pem"),
          chainPem: caPem,
          identityId: ULID,
          serial: certificate.serialNumber,
          notAfter: new Date(Date.now() + ttlDays * DAY_MS).toISOString(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/agent/consumer") {
        const parsed = body as { state?: string } | undefined;
        heartbeats.push(parsed?.state ?? "missing");
        send(response, 200, { state: parsed?.state ?? "ok" });
        return;
      }

      const secret = /^\/v1\/data\/[^/]+\/secrets\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && secret !== null) {
        const name = decodeURIComponent(secret[1] ?? "");
        const value = values.get(name);
        if (value === undefined) {
          send(response, 404, errorBody("secret_not_found", "Secret not found"));
          return;
        }
        send(response, 200, {
          id: ULID,
          projectId: ULID,
          name,
          value: value.value,
          encoding: value.encoding,
          contentType: "text/plain",
          tags: {},
          version: {
            id: ULID,
            createdAt: new Date().toISOString(),
            createdBy: ULID,
            expiresAt: null,
          },
          capabilities: {
            canRead: true,
            canWrite: false,
            canDelete: false,
            canPurge: false,
            canManage: false,
          },
        });
        return;
      }

      send(response, 404, errorBody("not_found", "Not found"));
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpsServer.once("error", reject);
    httpsServer.listen(0, () => resolve());
  });
  const address = httpsServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake vault did not bind");
  }
  return {
    url: new URL(`https://localhost:${address.port}`),
    caPath,
    caPem,
    requests,
    values,
    faults,
    issuedPublicKeys,
    heartbeats,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Builds a fake-vault fault key. */
export function faultKey(method: string, path: string): string {
  return `${method} ${path}`;
}
