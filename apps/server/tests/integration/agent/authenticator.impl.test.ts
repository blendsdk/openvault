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

  it("should keep the positive cache bounded and evict the oldest entry", async () => {
    await setup();
    try {
      const rows = new Map<string, Row>();
      const materials: AgentClientFixture[] = [];
      for (let index = 0; index < 3; index += 1) {
        const material = await createAgentClientCertificate(
          ca,
          `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
        );
        materials.push(material);
        rows.set(material.fingerprint, rowFor(material, new Date(Date.now() + 60_000)));
      }
      let queries = 0;
      const database = {
        async executeQuery<T>(
          _query: string,
          params?: Record<string, unknown>,
        ): Promise<{ readonly records: readonly T[] }> {
          queries += 1;
          const fingerprint =
            typeof params?.fingerprint === "string" ? params.fingerprint : undefined;
          const row = fingerprint === undefined ? undefined : rows.get(fingerprint);
          return { records: (row === undefined ? [] : [row]) as T[] };
        },
      };
      const authenticator = new DatabaseAgentAuthenticator({ database, limit: 2 });
      for (const material of materials) {
        const context = await authenticator.authenticate(
          agentRequest(Buffer.from(material.certificate.rawData)),
        );
        expect(context?.fingerprint).toBe(material.fingerprint);
      }
      expect(authenticator.size).toBe(2);

      const first = materials[0];
      if (first === undefined) {
        throw new Error("expected three certificate fixtures");
      }
      const before = queries;
      await authenticator.authenticate(agentRequest(Buffer.from(first.certificate.rawData)));
      expect(queries).toBe(before + 1);
      expect(authenticator.size).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("should fail a slow read and never cache a miss", async () => {
    await setup();
    try {
      let now = Date.now();
      const row = rowFor(client, new Date(now + 60_000));
      const slowDatabase = {
        async executeQuery<T>(): Promise<{ readonly records: readonly T[] }> {
          now += 5_001;
          return { records: [row] as T[] };
        },
      };
      const slow = new DatabaseAgentAuthenticator({
        database: slowDatabase,
        now: () => now,
      });
      await expect(
        slow.authenticate(agentRequest(Buffer.from(client.certificate.rawData))),
      ).resolves.toBeUndefined();

      let current: Row | undefined;
      let queries = 0;
      const database = {
        async executeQuery<T>(): Promise<{ readonly records: readonly T[] }> {
          queries += 1;
          return { records: (current === undefined ? [] : [current]) as T[] };
        },
      };
      const authenticator = new DatabaseAgentAuthenticator({ database });
      const raw = Buffer.from(client.certificate.rawData);
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeUndefined();
      current = rowFor(client, new Date(Date.now() + 60_000));
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeDefined();
      expect(queries).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("should not repopulate the cache when a revoke lands during the read", async () => {
    await setup();
    try {
      let authenticator: DatabaseAgentAuthenticator | undefined;
      const database = {
        async executeQuery<T>(): Promise<{ readonly records: readonly T[] }> {
          authenticator?.invalidatePrincipal("01ARZ3NDEKTSV4RRFFQ69G5FAV");
          return {
            records: [rowFor(client, new Date(Date.now() + 60_000))] as T[],
          };
        },
      };
      authenticator = new DatabaseAgentAuthenticator({ database });
      const context = await authenticator.authenticate(
        agentRequest(Buffer.from(client.certificate.rawData)),
      );
      expect(context).toBeDefined();
      expect(authenticator.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("should recheck notAfter for a cached context", async () => {
    await setup();
    try {
      let now = Date.now();
      let queries = 0;
      const row = rowFor(client, new Date(now + 1_000));
      const database = {
        async executeQuery<T>(): Promise<{ readonly records: readonly T[] }> {
          queries += 1;
          return { records: [row] as T[] };
        },
      };
      const authenticator = new DatabaseAgentAuthenticator({ database, now: () => now });
      const raw = Buffer.from(client.certificate.rawData);
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeDefined();
      now += 1_500;
      await expect(authenticator.authenticate(agentRequest(raw))).resolves.toBeUndefined();
      expect(queries).toBe(2);
    } finally {
      cleanup();
    }
  });
});
