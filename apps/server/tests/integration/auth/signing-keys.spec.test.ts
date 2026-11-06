import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUlid } from "@openvault/core";
import { decodeJwt, decodeProtectedHeader, importJWK, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CliTokenError } from "../../../src/auth/cli-jwt.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import {
  SigningKeyRepository,
  SigningKeyRotationError,
  type SigningKeyRow,
  SigningKeyService,
  SigningKeyUnavailableError,
  unwrapSigningSeed,
} from "../../../src/security/signing-keys.js";
import { writeFixtureFile } from "../../helpers/config-fixture.js";
import { testUlid } from "../helpers/fixtures.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

const START_MS = Date.parse("2026-10-30T12:00:00.000Z");
const ACCESS_LIFETIME_MS = 900_000;
const OVERLAP_MS = (15 * 60 + 30) * 1_000;
const PRINCIPAL_ID = testUlid(900);
const FAMILY_ID = testUlid(901);
const REPLACEMENT_KID = testUlid(902);

let testDb: TestDatabase;
let keyring: KeyringProvider | undefined;
let keyringDirectory: string | undefined;
let nowMs = START_MS;

interface SigningKeySnapshot {
  readonly kid: string;
  readonly publicKeyLength: number;
  readonly wrappedSeedLength: number;
  readonly wrapNonceLength: number;
  readonly wrapTagLength: number;
  readonly kekId: string;
  readonly status: string;
  readonly activatedAt: Date;
  readonly retiredAt: Date | null;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
});

beforeEach(async () => {
  await testDb.db.executeQuery("DELETE FROM signing_keys");
  nowMs = START_MS;
  keyringDirectory = mkdtempSync(join(tmpdir(), "openvault-signing-keys-"));
  const keyringPath = writeFixtureFile(
    keyringDirectory,
    "keyring.json",
    JSON.stringify({
      version: 1,
      current: "k1",
      keys: {
        k1: randomBytes(32).toString("base64"),
        k2: randomBytes(32).toString("base64"),
      },
    }),
  );
  keyring = await KeyringProvider.load(keyringPath);
});

afterEach(() => {
  keyring?.destroy();
  keyring = undefined;
  if (keyringDirectory) {
    rmSync(keyringDirectory, { recursive: true, force: true });
    keyringDirectory = undefined;
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

/** Returns the loaded keyring or fails with a clear fixture error. */
function requireKeyring(): KeyringProvider {
  if (!keyring) {
    throw new Error("keyring fixture is not ready");
  }
  return keyring;
}

/** Creates a service instance that shares the current test database and keyring. */
function createService(
  options: {
    readonly keyring?: KeyringProvider;
    readonly now?: () => number;
    readonly onPreviousKeyRejected?: (kid: string) => void;
  } = {},
): SigningKeyService {
  return new SigningKeyService({
    repository: new SigningKeyRepository(testDb.db),
    keyring: options.keyring ?? requireKeyring(),
    now: options.now ?? (() => nowMs),
    ...(options.onPreviousKeyRejected === undefined
      ? {}
      : { onPreviousKeyRejected: options.onPreviousKeyRejected }),
  });
}

/** Reads every signing-key row with the byte lengths needed by the assertions. */
async function signingKeyRows(): Promise<SigningKeySnapshot[]> {
  const result = await testDb.db.executeQuery<{
    kid: string;
    public_key_length: number;
    wrapped_seed_length: number;
    wrap_nonce_length: number;
    wrap_tag_length: number;
    kek_id: string;
    status: string;
    activated_at: Date;
    retired_at: Date | null;
  }>(
    `SELECT kid,
            octet_length(public_key) AS public_key_length,
            octet_length(wrapped_seed) AS wrapped_seed_length,
            octet_length(wrap_nonce) AS wrap_nonce_length,
            octet_length(wrap_tag) AS wrap_tag_length,
            kek_id,
            status,
            activated_at,
            retired_at
       FROM signing_keys
      ORDER BY activated_at, kid`,
  );

  return result.records.map((row) => ({
    kid: row.kid,
    publicKeyLength: row.public_key_length,
    wrappedSeedLength: row.wrapped_seed_length,
    wrapNonceLength: row.wrap_nonce_length,
    wrapTagLength: row.wrap_tag_length,
    kekId: row.kek_id,
    status: row.status,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  }));
}

/** Runs a deliberately invalid update with the lifecycle guard disabled. */
async function withLifecycleTriggerDisabled<T>(action: () => Promise<T>): Promise<T> {
  await testDb.db.executeQuery(
    "ALTER TABLE signing_keys DISABLE TRIGGER signing_keys_guard_lifecycle",
  );
  try {
    return await action();
  } finally {
    await testDb.db.executeQuery(
      "ALTER TABLE signing_keys ENABLE TRIGGER signing_keys_guard_lifecycle",
    );
  }
}

/** Returns the first row or fails the test with a clear message. */
function requireFirst<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error("expected at least one row");
  }
  return row;
}

/** Builds a claim set that is valid at the supplied second. */
function tokenClaims(issuedAtSeconds: number): Record<string, unknown> {
  return {
    iss: "openvault",
    aud: "openvault-cli",
    sub: PRINCIPAL_ID,
    sid: FAMILY_ID,
    jti: testUlid(903),
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + 900,
    kind: "user",
  };
}

/** Reads one complete key row for signing a test token with its stored seed. */
async function readStoredKey(kid: string): Promise<SigningKeyRow> {
  const result = await testDb.db.executeQuery<{
    kid: string;
    public_key: Buffer;
    wrapped_seed: Buffer;
    wrap_nonce: Buffer;
    wrap_tag: Buffer;
    kek_id: string;
    status: string;
    created_at: Date;
    activated_at: Date;
    retired_at: Date | null;
  }>(
    `SELECT kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status,
            created_at, activated_at, retired_at
       FROM signing_keys
      WHERE kid = :kid`,
    { kid },
  );
  const row = requireFirst(result.records);
  if (row.status !== "current" && row.status !== "previous" && row.status !== "retired") {
    throw new Error("unexpected key status");
  }
  return {
    kid: row.kid,
    publicKey: row.public_key,
    wrappedSeed: row.wrapped_seed,
    wrapNonce: row.wrap_nonce,
    wrapTag: row.wrap_tag,
    kekId: row.kek_id,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  };
}

/** Signs a token with the key material stored under one key id. */
async function tokenFromStoredKey(
  kid: string,
  issuedAtSeconds: number,
  headerKid = kid,
): Promise<string> {
  const row = await readStoredKey(kid);
  const seed = unwrapSigningSeed(requireKeyring(), row);
  try {
    const privateKey = await importJWK(
      {
        kty: "OKP",
        crv: "Ed25519",
        x: row.publicKey.toString("base64url"),
        d: seed.toString("base64url"),
      },
      "EdDSA",
    );
    return await new SignJWT(tokenClaims(issuedAtSeconds))
      .setProtectedHeader({ alg: "EdDSA", kid: headerKid })
      .sign(privateKey);
  } finally {
    seed.fill(0);
  }
}

describe("first signing key", () => {
  it("should create one current key and return the same kid when ensure runs twice", async () => {
    const service = createService();

    await service.ensure();
    const first = await signingKeyRows();
    await service.ensure();
    const second = await signingKeyRows();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      kid: requireFirst(first).kid,
      status: "current",
      publicKeyLength: 32,
      wrappedSeedLength: 32,
      wrapNonceLength: 12,
      wrapTagLength: 16,
      kekId: "k1",
      retiredAt: null,
    });
    expect(second[0]?.activatedAt).toBeInstanceOf(Date);
  });

  it("should store the seed only in a wrapped column and never as raw key material", async () => {
    const result = await testDb.db.executeQuery<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signing_keys'
        ORDER BY ordinal_position`,
    );
    const columns = result.records.map((row) => row.column_name);

    expect([...columns].sort()).toEqual([
      "activated_at",
      "created_at",
      "kek_id",
      "kid",
      "public_key",
      "retired_at",
      "status",
      "wrap_nonce",
      "wrap_tag",
      "wrapped_seed",
    ]);
    expect(columns).not.toContain("seed");
    expect(columns).not.toContain("raw_seed");
    expect(columns).not.toContain("private_key");
    expect(columns).not.toContain("private_key_seed");
  });

  it("should create exactly one current key when two callers ensure concurrently", async () => {
    const first = createService();
    const second = createService();

    await Promise.all([first.ensure(), second.ensure()]);
    const rows = await signingKeyRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("current");
    expect(isUlid(requireFirst(rows).kid)).toBe(true);
  });
});

describe("wrapped seed handling", () => {
  it("should reject a tampered wrapped seed without exposing key material", async () => {
    const service = createService();
    await service.ensure();
    const row = requireFirst(await signingKeyRows());

    await withLifecycleTriggerDisabled(() =>
      testDb.db.executeQuery(
        `UPDATE signing_keys
            SET wrapped_seed = set_byte(wrapped_seed, 0, (get_byte(wrapped_seed, 0) # 255))
          WHERE kid = :kid`,
        { kid: row.kid },
      ),
    );

    let failure: unknown;
    try {
      await createService().signAccessToken({
        principalId: PRINCIPAL_ID,
        familyId: FAMILY_ID,
        nowMs,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SigningKeyUnavailableError);
    const message = failure instanceof Error ? failure.message : "";
    const stored = await testDb.db.executeQuery<{ wrapped_seed: Buffer; public_key: Buffer }>(
      "SELECT wrapped_seed, public_key FROM signing_keys WHERE kid = :kid",
      { kid: row.kid },
    );
    const storedRow = requireFirst(stored.records);
    expect(message).not.toContain(storedRow.wrapped_seed.toString("hex"));
    expect(message).not.toContain(storedRow.wrapped_seed.toString("base64"));
    expect(message).not.toContain(storedRow.public_key.toString("hex"));
  });

  it("should reject a flipped wrap tag", async () => {
    const service = createService();
    await service.ensure();
    const row = requireFirst(await signingKeyRows());

    await withLifecycleTriggerDisabled(() =>
      testDb.db.executeQuery(
        `UPDATE signing_keys
            SET wrap_tag = set_byte(wrap_tag, 0, (get_byte(wrap_tag, 0) # 255))
          WHERE kid = :kid`,
        { kid: row.kid },
      ),
    );

    await expect(
      createService().signAccessToken({ principalId: PRINCIPAL_ID, familyId: FAMILY_ID, nowMs }),
    ).rejects.toBeInstanceOf(SigningKeyUnavailableError);
  });

  it("should reject a seed whose key id no longer matches its authentication tag", async () => {
    const service = createService();
    await service.ensure();
    const row = requireFirst(await signingKeyRows());

    await withLifecycleTriggerDisabled(() =>
      testDb.db.executeQuery("UPDATE signing_keys SET kid = :replacementKid WHERE kid = :kid", {
        kid: row.kid,
        replacementKid: REPLACEMENT_KID,
      }),
    );

    await expect(
      createService().signAccessToken({ principalId: PRINCIPAL_ID, familyId: FAMILY_ID, nowMs }),
    ).rejects.toBeInstanceOf(SigningKeyUnavailableError);
  });

  it("should reject a seed whose recorded key encryption key cannot unwrap it", async () => {
    const service = createService();
    await service.ensure();
    const row = requireFirst(await signingKeyRows());

    await withLifecycleTriggerDisabled(() =>
      testDb.db.executeQuery("UPDATE signing_keys SET kek_id = 'k2' WHERE kid = :kid", {
        kid: row.kid,
      }),
    );

    await expect(
      createService().signAccessToken({ principalId: PRINCIPAL_ID, familyId: FAMILY_ID, nowMs }),
    ).rejects.toBeInstanceOf(SigningKeyUnavailableError);
  });
});

describe("previous key authentication", () => {
  it("should reject a previous public key that does not derive from its wrapped seed", async () => {
    const service = createService();
    await service.ensure();
    const current = requireFirst(await signingKeyRows());

    const replacement = generateKeyPairSync("ed25519");
    const spki = replacement.publicKey.export({ format: "der", type: "spki" });
    const replacementKid = testUlid(950);
    await testDb.db.executeQuery(
      `INSERT INTO signing_keys
         (kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status, activated_at)
       VALUES
         (:kid, :publicKey, :wrappedSeed, :nonce, :tag, 'k1', 'previous', :activatedAt)`,
      {
        kid: replacementKid,
        publicKey: spki.subarray(spki.length - 32),
        wrappedSeed: randomBytes(32),
        nonce: randomBytes(12),
        tag: randomBytes(16),
        activatedAt: new Date(nowMs),
      },
    );

    const forged = await new SignJWT(tokenClaims(Math.floor(nowMs / 1_000)))
      .setProtectedHeader({ alg: "EdDSA", kid: replacementKid })
      .sign(replacement.privateKey);
    await expect(createService().verifyAccessToken(forged)).rejects.toBeInstanceOf(CliTokenError);

    const currentToken = await createService().signAccessToken({
      principalId: PRINCIPAL_ID,
      familyId: FAMILY_ID,
      nowMs,
    });
    await expect(createService().verifyAccessToken(currentToken.token)).resolves.toMatchObject({
      sub: PRINCIPAL_ID,
      sid: FAMILY_ID,
    });
    expect(current.kid).not.toBe(replacementKid);
  });

  it("should report a rejected previous row and keep current verification working", async () => {
    const rejected: string[] = [];
    const service = createService();
    await service.ensure();
    const kid = testUlid(951);
    await testDb.db.executeQuery(
      `INSERT INTO signing_keys
         (kid, public_key, wrapped_seed, wrap_nonce, wrap_tag, kek_id, status, activated_at)
       VALUES
         (:kid, :publicKey, :wrappedSeed, :nonce, :tag, 'k1', 'previous', :activatedAt)`,
      {
        kid,
        publicKey: randomBytes(32),
        wrappedSeed: randomBytes(32),
        nonce: randomBytes(12),
        tag: randomBytes(16),
        activatedAt: new Date(nowMs),
      },
    );

    const currentToken = await service.signAccessToken({
      principalId: PRINCIPAL_ID,
      familyId: FAMILY_ID,
      nowMs,
    });
    const verifier = createService({
      onPreviousKeyRejected: (rejectedKid) => {
        rejected.push(rejectedKid);
      },
    });
    await expect(verifier.verifyAccessToken(currentToken.token)).resolves.toMatchObject({
      sub: PRINCIPAL_ID,
    });
    expect(rejected).toContain(kid);
  });

  it("should reject lifecycle mutations and illegal status transitions", async () => {
    const service = createService();
    await service.ensure();
    const current = requireFirst(await signingKeyRows());

    await expect(
      testDb.db.executeQuery("UPDATE signing_keys SET activated_at = now() WHERE kid = :kid", {
        kid: current.kid,
      }),
    ).rejects.toThrow();
    await expect(
      testDb.db.executeQuery(
        "UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE kid = :kid",
        { kid: current.kid },
      ),
    ).rejects.toThrow();
    await expect(
      testDb.db.executeQuery("UPDATE signing_keys SET status = status WHERE kid = :kid", {
        kid: current.kid,
      }),
    ).resolves.toBeDefined();

    nowMs = START_MS + 60_000;
    await service.rotate();
    nowMs += OVERLAP_MS + 1;
    await service.retireDue();
    const retired = (await signingKeyRows()).find((row) => row.status === "retired");
    if (retired === undefined) {
      throw new Error("expected a retired key");
    }
    await expect(
      testDb.db.executeQuery(
        "UPDATE signing_keys SET status = 'current', retired_at = NULL WHERE kid = :kid",
        { kid: retired.kid },
      ),
    ).rejects.toThrow();
  });
});

describe("issued access tokens", () => {
  it("should sign with the current key and expose the documented header and claims", async () => {
    const service = createService();
    await service.ensure();
    const current = requireFirst(await signingKeyRows());

    const issued = await service.signAccessToken({
      principalId: PRINCIPAL_ID,
      familyId: FAMILY_ID,
      nowMs,
    });

    expect(issued.expiresAt).toBe(nowMs + ACCESS_LIFETIME_MS);
    expect(decodeProtectedHeader(issued.token)).toMatchObject({ alg: "EdDSA", kid: current.kid });

    const payload = decodeJwt(issued.token);
    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "jti",
      "kind",
      "sid",
      "sub",
    ]);
    expect(payload).toMatchObject({
      iss: "openvault",
      aud: "openvault-cli",
      sub: PRINCIPAL_ID,
      sid: FAMILY_ID,
      kind: "user",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
    expect(isUlid(String(payload.jti))).toBe(true);

    await expect(service.verifyAccessToken(issued.token)).resolves.toMatchObject({
      sub: PRINCIPAL_ID,
      sid: FAMILY_ID,
    });
  });

  it("should round-trip the wrapped seed by signing and verifying with a fresh service", async () => {
    await createService().ensure();

    const issued = await createService().signAccessToken({
      principalId: PRINCIPAL_ID,
      familyId: FAMILY_ID,
      nowMs,
    });
    const claims = await createService().verifyAccessToken(issued.token);

    expect(claims.sub).toBe(PRINCIPAL_ID);
    expect(claims.sid).toBe(FAMILY_ID);
  });
});

describe("key rotation and overlap", () => {
  it("should promote the current key to previous and keep its token verifiable inside the window", async () => {
    const service = createService();
    await service.ensure();
    const old = requireFirst(await signingKeyRows());
    const oldToken = (
      await service.signAccessToken({ principalId: PRINCIPAL_ID, familyId: FAMILY_ID, nowMs })
    ).token;

    nowMs = START_MS + 60_000;
    const rotated = await service.rotate();
    const rows = await signingKeyRows();

    const current = rows.find((row) => row.status === "current");
    const previous = rows.find((row) => row.status === "previous");
    expect(current?.kid).toBe(rotated.kid);
    expect(current?.kid).not.toBe(old.kid);
    expect(previous?.kid).toBe(old.kid);
    expect(previous?.retiredAt).toBeNull();

    await expect(service.verifyAccessToken(oldToken)).resolves.toMatchObject({
      sub: PRINCIPAL_ID,
      sid: FAMILY_ID,
    });
  });

  it("should refuse a second rotation while the previous key is still inside the overlap window", async () => {
    const service = createService();
    await service.ensure();
    await service.rotate();

    await expect(service.rotate()).rejects.toBeInstanceOf(SigningKeyRotationError);
    expect(await signingKeyRows()).toHaveLength(2);
  });

  it("should reject a time-valid previous token once the overlap window ends", async () => {
    const service = createService();
    await service.ensure();
    const oldKid = requireFirst(await signingKeyRows()).kid;

    nowMs = START_MS + 60_000;
    await service.rotate();
    const previousKid = (await signingKeyRows()).find((row) => row.kid === oldKid)?.kid;
    if (previousKid === undefined) {
      throw new Error("expected the old key to remain");
    }
    nowMs += OVERLAP_MS + 1;

    const previousToken = await tokenFromStoredKey(previousKid, Math.floor(nowMs / 1_000));
    await expect(service.verifyAccessToken(previousToken)).rejects.toBeInstanceOf(CliTokenError);
    expect((await signingKeyRows()).find((row) => row.status === "previous")?.retiredAt).toBeNull();
  });

  it("should retire the due previous key and reject a time-valid token afterwards", async () => {
    const service = createService();
    await service.ensure();
    const oldKid = requireFirst(await signingKeyRows()).kid;

    nowMs = START_MS + 60_000;
    await service.rotate();
    nowMs += OVERLAP_MS + 1;

    await expect(service.retireDue()).resolves.toBe(1);
    const previous = (await signingKeyRows()).find((row) => row.status === "retired");
    expect(previous?.retiredAt).toBeInstanceOf(Date);
    const retiredToken = await tokenFromStoredKey(oldKid, Math.floor(nowMs / 1_000));
    await expect(service.verifyAccessToken(retiredToken)).rejects.toBeInstanceOf(CliTokenError);
  });

  it("should reject a token whose kid is retired or unknown", async () => {
    const service = createService();
    await service.ensure();
    const oldKid = requireFirst(await signingKeyRows()).kid;
    nowMs = START_MS + 60_000;
    await service.rotate();
    nowMs += OVERLAP_MS + 1;
    await service.retireDue();

    const currentKid = (await signingKeyRows()).find((row) => row.status === "current")?.kid;
    if (currentKid === undefined) {
      throw new Error("expected a current key");
    }
    const retiredToken = await tokenFromStoredKey(currentKid, Math.floor(nowMs / 1_000), oldKid);
    const unknownToken = await tokenFromStoredKey(
      currentKid,
      Math.floor(nowMs / 1_000),
      testUlid(904),
    );

    await expect(service.verifyAccessToken(retiredToken)).rejects.toBeInstanceOf(CliTokenError);
    await expect(service.verifyAccessToken(unknownToken)).rejects.toBeInstanceOf(CliTokenError);
  });

  it("should observe another service's retirement after the cache expires", async () => {
    const first = createService();
    const second = createService();
    await first.ensure();
    const oldKid = requireFirst(await signingKeyRows()).kid;

    nowMs = START_MS + 60_000;
    await second.rotate();
    const insideOverlap = await tokenFromStoredKey(oldKid, Math.floor(nowMs / 1_000));
    await expect(first.verifyAccessToken(insideOverlap)).resolves.toMatchObject({
      sub: PRINCIPAL_ID,
    });

    nowMs += OVERLAP_MS + 1;
    await second.retireDue();
    const afterRetirement = await tokenFromStoredKey(oldKid, Math.floor(nowMs / 1_000));

    await expect(first.verifyAccessToken(afterRetirement)).rejects.toBeInstanceOf(CliTokenError);
  });
});
