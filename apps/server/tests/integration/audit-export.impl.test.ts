import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditExporter } from "../../src/audit/audit-export.js";
import { AuditService } from "../../src/audit/audit-service.js";
import { AuditWriter } from "../../src/audit/audit-writer.js";
import { AuditUnavailableError } from "../../src/audit/errors.js";
import { PersistentPolicyAudit } from "../../src/audit/policy-audit.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  type AuditActors,
  type AuditHarness,
  createAuditHarness,
  recordEvent,
  resetAuditTables,
  seedAuditActors,
} from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let harness: AuditHarness;
let actors: AuditActors;
let currentTime = Date.parse("2026-10-01T00:00:00.000Z");

const clock = (): number => currentTime;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  harness = createAuditHarness(testDb, keyring, clock);
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  currentTime = Date.parse("2026-10-01T00:00:00.000Z");
  await resetAuditTables(testDb.db);
});

/** Writer that fails only when the export attempt event is written. */
class FailingExportWriter extends AuditWriter {
  public override async record(
    input: Parameters<AuditWriter["record"]>[0],
    tx?: Parameters<AuditWriter["record"]>[1],
    options?: Parameters<AuditWriter["record"]>[2],
  ): ReturnType<AuditWriter["record"]> {
    if (input.action === "audit.export") {
      throw new AuditUnavailableError("export write failed");
    }
    return super.record(input, tx, options);
  }
}

describe("audit export internals", () => {
  it("should await each consumer write before producing the next line", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    const lines: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWrite: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });

    const exporter = new AuditExporter({ database: testDb.db, keyring });
    const running = exporter.export({
      filters: { action: "project.read" },
      visibility: { kind: "all" },
      write: async (line) => {
        lines.push(line);
        if (lines.length === 1) {
          firstWrite?.();
          await gate;
        }
      },
    });
    await first;
    expect(lines).toHaveLength(1);
    release?.();
    await running;
    expect(lines).toHaveLength(3);
  });

  it("should fail before headers when the export attempt write fails", async () => {
    currentTime += 1_000;
    await recordEvent(harness, base);
    const writer = new FailingExportWriter({ database: testDb.db, keyring, now: clock });
    const adapter = new PersistentPolicyAudit({ writer, database: testDb.db, now: clock });
    const policy = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: adapter,
    });
    const service = new AuditService({
      writer,
      query: harness.query,
      verifier: harness.verifier,
      exporter: harness.exporter,
      policy,
      now: clock,
    });
    let started = false;
    await expect(
      service.export(
        actors.orgAdmin,
        { action: "project.read" },
        { requestId: "export-attempt" },
        () => {
          started = true;
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(started).toBe(false);
  });

  it("should reject when the consumer fails mid-stream", async () => {
    for (let index = 0; index < 3; index += 1) {
      currentTime += 1_000;
      await recordEvent(harness, base);
    }
    let calls = 0;
    const exporter = new AuditExporter({ database: testDb.db, keyring });
    await expect(
      exporter.export({
        filters: { action: "project.read" },
        visibility: { kind: "all" },
        write: async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error("client disconnected");
          }
        },
      }),
    ).rejects.toThrow("client disconnected");
    expect(calls).toBe(2);
  });
});
