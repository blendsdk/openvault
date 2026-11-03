import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliSessionRepository } from "../../src/auth/cli-sessions.js";
import { CredentialsRepository } from "../../src/auth/credentials.js";
import { OidcAccessDeniedError } from "../../src/auth/oidc/errors.js";
import { OidcIdentityService } from "../../src/auth/oidc/identity.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let testDb: TestDatabase;
let base: BaseFixture;
let credentials: CredentialsRepository;
let oidc: OidcIdentityService;
let cliSessions: CliSessionRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  credentials = new CredentialsRepository(testDb.db);
  oidc = new OidcIdentityService({ database: testDb.db });
  cliSessions = new CliSessionRepository(testDb.db);
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
});

/** Creates a legacy service-principal credential/session with its guard disabled. */
async function withGuardDisabled(
  triggerTable: "local_credentials" | "oidc_identities" | "cli_sessions",
  triggerName: string,
  action: () => Promise<void>,
): Promise<void> {
  await testDb.db.executeQuery(`ALTER TABLE ${triggerTable} DISABLE TRIGGER ${triggerName}`);
  try {
    await action();
  } finally {
    await testDb.db.executeQuery(`ALTER TABLE ${triggerTable} ENABLE TRIGGER ${triggerName}`);
  }
}

describe("service principal read-path rejection", () => {
  it("should not resolve a browser status or a local credential for a service principal", async () => {
    await withGuardDisabled("local_credentials", "local_credentials_service_guard", async () => {
      await testDb.db.executeQuery(
        `INSERT INTO local_credentials (principal_id, password_hash)
           VALUES (:principalId, :hash)`,
        { principalId: base.serviceId, hash: HASH },
      );
    });

    await expect(credentials.findStatus(base.serviceId)).resolves.toBeUndefined();
    await expect(credentials.findByPrincipalId(base.serviceId)).resolves.toBeUndefined();
  });

  it("should not resolve an existing OIDC linkage for a service principal", async () => {
    await withGuardDisabled("oidc_identities", "oidc_identities_service_guard", async () => {
      await testDb.db.executeQuery(
        `INSERT INTO oidc_identities (principal_id, issuer, subject)
         VALUES (:principalId, :issuer, :subject)`,
        {
          principalId: base.serviceId,
          issuer: "https://idp.example.test",
          subject: "service-subject",
        },
      );
    });

    await expect(
      oidc.resolve({
        issuer: "https://idp.example.test",
        subject: "service-subject",
        claims: {},
        userInfo: {},
        allowedDomains: [],
      }),
    ).rejects.toBeInstanceOf(OidcAccessDeniedError);
  });

  it("should not resolve a live CLI family or rotate its refresh token for a service principal", async () => {
    const familyId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const refreshToken = "s".repeat(43);
    const refreshHash = createHash("sha256").update(refreshToken).digest();
    await withGuardDisabled("cli_sessions", "cli_sessions_service_guard", async () => {
      await testDb.db.executeQuery(
        `INSERT INTO cli_sessions (id, principal_id, refresh_hash, family_id, expires_at)
         VALUES (:id, :principalId, :refreshHash, :familyId, :expiresAt)`,
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          principalId: base.serviceId,
          refreshHash,
          familyId,
          expiresAt: "2027-10-30T12:00:00.000Z",
        },
      );
    });

    await expect(cliSessions.findActiveContext(base.serviceId, familyId)).resolves.toBeUndefined();
    await expect(
      cliSessions.rotateRefresh(refreshHash, base.serviceId, familyId, {
        ip: null,
        userAgent: null,
      }),
    ).resolves.toEqual({ kind: "invalid" });
  });
});
