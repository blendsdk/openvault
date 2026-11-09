import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditCore } from "../../../src/audit/runtime.js";
import { ProjectRepository } from "../../../src/projects/repository.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import { SecretRepository } from "../../../src/secrets/repository.js";
import { SecretRotationRepository } from "../../../src/secrets/rotation/repository.js";
import { SecretService } from "../../../src/secrets/service.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import { type AuditActors, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "../helpers/fixtures.js";
import { createServerEnvironment } from "../helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";
import { createSecretAt, setRotationPolicy } from "./rotation-helpers.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let secrets: SecretService;
const repository = new SecretRotationRepository();

function name(prefix: string): string {
  return `${prefix}-${newUlid().slice(-10).toLowerCase()}`;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring, now: () => NOW.getTime() });
  const policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
    now: () => NOW.getTime(),
  });
  secrets = new SecretService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new SecretRepository(),
    secretMaxBytes: 65_536,
    softDeleteDays: 30,
    rotationWarningDays: 7,
    now: () => NOW.getTime(),
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

describe("rotation repository implementation", () => {
  it("should page eligible rows with a keyset cursor without duplicates", async () => {
    const names = [name("page-a"), name("page-b"), name("page-c")];
    const dates = [
      "2026-10-01T12:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
    ];
    for (const [index, entry] of names.entries()) {
      const createdAt = dates[index];
      if (createdAt === undefined) {
        throw new Error("Missing test date");
      }
      await createSecretAt(
        testDb.db,
        secrets,
        actors.orgAdmin,
        "foundation",
        entry,
        createdAt,
        base.userId,
      );
      await setRotationPolicy(secrets, actors.orgAdmin, "foundation", entry, 30);
    }
    const first = await repository.listEligible(testDb.db, NOW, 7, undefined, 2);
    expect(first).toHaveLength(2);
    const last = first[first.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) {
      return;
    }
    const second = await repository.listEligible(
      testDb.db,
      NOW,
      7,
      { dueAt: last.dueAt, secretId: last.secretId },
      2,
    );
    const allNames = [...first, ...second].map((row) => row.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames).toEqual(expect.arrayContaining(names));
  });

  it("should reject a due date that no longer matches the policy", async () => {
    const subject = name("eligibility");
    await createSecretAt(
      testDb.db,
      secrets,
      actors.orgAdmin,
      "foundation",
      subject,
      "2026-10-10T12:00:00.000Z",
      base.userId,
    );
    await setRotationPolicy(secrets, actors.orgAdmin, "foundation", subject, 30);
    const candidates = await repository.listEligible(testDb.db, NOW, 7, undefined, 100);
    const candidate = candidates.find((row) => row.name === subject);
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }
    expect(
      await repository.isEligible(
        testDb.db,
        candidate.secretId,
        candidate.versionId,
        candidate.dueAt,
        NOW,
        7,
      ),
    ).toBe(true);
    await setRotationPolicy(secrets, actors.orgAdmin, "foundation", subject, 20);
    expect(
      await repository.isEligible(
        testDb.db,
        candidate.secretId,
        candidate.versionId,
        candidate.dueAt,
        NOW,
        7,
      ),
    ).toBe(false);
  });
});
