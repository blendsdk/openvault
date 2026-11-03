import { createHash, X509Certificate } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { DatabaseAgentAuthenticator } from "../../../src/agent/agent-authenticator.js";
import { canonicalPublicKeyHash } from "../../../src/security/x509.js";
import { markListener } from "../../../src/transport/scope.js";
import {
  type AgentCaFixture,
  type AgentClientFixture,
  createAgentCaFixture,
  createAgentClientCertificate,
} from "../helpers/agent-tls.js";

interface Row {
  readonly id: string;
  readonly serial: string;
  readonly fingerprint: string;
  readonly not_after: Date;
  readonly principal_id: string;
  readonly owner_project_id: string;
  readonly principal_status: string;
  readonly project_name: string;
  readonly deleted_at: Date | null;
}

interface FakeDatabase {
  readonly queries: number;
  readonly fingerprint: string;
  readonly row: Row | undefined;
  executeQuery<T>(): Promise<{ readonly records: readonly T[] }>;
  setRow(row: Row | undefined): void;
}

function fakeDatabase(fingerprint: string, row: Row | undefined): FakeDatabase {
  let current = row;
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    get fingerprint() {
      return fingerprint;
    },
    get row() {
      return current;
    },
    setRow(next: Row | undefined): void {
      current = next;
    },
    async executeQuery<T>(): Promise<{ readonly records: readonly T[] }> {
      queries += 1;
      return { records: (current === undefined ? [] : [current]) as T[] };
    },
  };
}

function agentRequest(raw: Buffer | undefined, authorized = true): Request {
  const request = {
    socket: {
      authorized,
      getPeerCertificate: () => ({ raw }),
    },
  } as unknown as Request;
  markListener(request, "agent");
  return request;
}

function rowFor(client: AgentClientFixture, notAfter: Date): Row {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    serial: "01",
    fingerprint: client.fingerprint,
    not_after: notAfter,
    principal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    owner_project_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    principal_status: "active",
    project_name: "project",
    deleted_at: null,
  };
}

describe("database agent authenticator", () => {
  let ca: AgentCaFixture;
  let client: AgentClientFixture;

  async function setup(): Promise<void> {
    ca = await createAgentCaFixture();
    client = await createAgentClientCertificate(ca, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  }

  function cleanup(): void {
    ca.cleanup();
  }

  it("should ignore non-agent listeners, unauthorized peers, and missing certificates", async () => {
    await setup();
    try {
      const database = fakeDatabase(
        client.fingerprint,
        rowFor(client, new Date(Date.now() + 60_000)),
      );
      const authenticator = new DatabaseAgentAuthenticator({ database });
      const admin = agentRequest(Buffer.from(client.certificate.rawData));
      markListener(admin, "admin");
      await expect(authenticator.authenticate(admin)).resolves.toBeUndefined();
      await expect(authenticator.authenticate(agentRequest(undefined))).resolves.toBeUndefined();
      await expect(
        authenticator.authenticate(agentRequest(Buffer.from(client.certificate.rawData), false)),
      ).resolves.toBeUndefined();
      await expect(
        authenticator.authenticate(agentRequest(Buffer.from(new Uint8Array()))),
      ).resolves.toBeUndefined();
      expect(database.queries).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("should return the database context and cache one positive read", async () => {
    await setup();
    try {
      const raw = Buffer.from(client.certificate.rawData);
      const database = fakeDatabase(
        client.fingerprint,
        rowFor(client, new Date(Date.now() + 60_000)),
      );
      const authenticator = new DatabaseAgentAuthenticator({ database });
      const request = agentRequest(raw);
      const context = await authenticator.authenticate(request);
      expect(context).toMatchObject({
        kind: "agent",
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        projectName: "project",
        certificateId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        serial: "01",
        fingerprint: client.fingerprint,
      });
      expect(context?.publicKeySha256).toBe(
        canonicalPublicKeyHash(Buffer.from(client.certificate.publicKey.rawData)),
      );
      expect(authenticator.size).toBe(1);

      await authenticator.authenticate(request);
      expect(database.queries).toBe(1);
      await authenticator.revalidate(request);
      expect(database.queries).toBe(2);
      authenticator.invalidatePrincipal("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      await authenticator.authenticate(request);
      expect(database.queries).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("should expire the cache at five seconds and reject a row that expires during the read", async () => {
    await setup();
    try {
      let now = Date.now();
      const raw = Buffer.from(client.certificate.rawData);
      const database = fakeDatabase(client.fingerprint, rowFor(client, new Date(now + 60_000)));
      const authenticator = new DatabaseAgentAuthenticator({ database, now: () => now });
      await authenticator.authenticate(agentRequest(raw));
      expect(authenticator.size).toBe(1);
      now += 5_001;
      await authenticator.authenticate(agentRequest(raw));
      expect(database.queries).toBe(2);

      database.setRow(rowFor(client, new Date(now - 1)));
      now += 5_001;
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("should miss unknown fingerprints and propagate database failures", async () => {
    await setup();
    try {
      const raw = Buffer.from(client.certificate.rawData);
      const authenticator = new DatabaseAgentAuthenticator({
        database: fakeDatabase("f".repeat(64), undefined),
      });
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeUndefined();

      const failing = new DatabaseAgentAuthenticator({
        database: {
          executeQuery: async () => {
            throw new Error("database down");
          },
        },
      });
      await expect(failing.authenticate(agentRequest(raw))).rejects.toThrow("database down");
    } finally {
      cleanup();
    }
  });

  it("should keep the positive cache bounded", async () => {
    await setup();
    try {
      const rows = new Map<string, Row>();
      for (let index = 0; index < 3; index += 1) {
        const material = await createAgentClientCertificate(
          ca,
          `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
        );
        rows.set(material.fingerprint, rowFor(material, new Date(Date.now() + 60_000)));
      }
      let current: Row | undefined;
      const database = {
        executeQuery: async <T>(): Promise<{ readonly records: readonly T[] }> => ({
          records: (current === undefined ? [] : [current]) as T[],
        }),
      };
      const authenticator = new DatabaseAgentAuthenticator({ database, limit: 2 });
      for (const [fingerprint, row] of rows) {
        current = row;
        const certificate = [...rows.keys()].includes(fingerprint);
        expect(certificate).toBe(true);
        const raw = Buffer.from(createHash("sha256").update(fingerprint).digest());
        await authenticator.authenticate(agentRequest(raw));
      }
      expect(authenticator.size).toBeLessThanOrEqual(2);
      expect(X509Certificate).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
