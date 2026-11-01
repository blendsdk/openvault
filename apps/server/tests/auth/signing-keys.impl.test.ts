import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUlid, KeyringError } from "@openvault/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  generateSigningKey,
  SIGNING_KEY_OVERLAP_MS,
  SigningKeyRepository,
  type SigningKeyRow,
  SigningKeyService,
  SigningKeyUnavailableError,
  unwrapSigningSeed,
  wrapSigningSeed,
} from "../../src/security/signing-keys.js";
import { writeFixtureFile } from "../helpers/config-fixture.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../integration/helpers/test-database.js";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

let directory: string | undefined;
let testDb: TestDatabase | undefined;
let nowMs = NOW_MS;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
});

afterAll(async () => {
  await testDb?.cleanup();
});

beforeEach(() => {
  nowMs = NOW_MS;
});

afterEach(() => {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

function keyringFixture(): Promise<KeyringProvider> {
  directory = mkdtempSync(join(tmpdir(), "openvault-signing-impl-"));
  const path = writeFixtureFile(
    directory,
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
  return KeyringProvider.load(path);
}

function rowFromWrapped(
  kid: string,
  wrapped: {
    readonly wrappedSeed: Buffer;
    readonly wrapNonce: Buffer;
    readonly wrapTag: Buffer;
    readonly kekId: string;
  },
): SigningKeyRow {
  return {
    kid,
    publicKey: Buffer.alloc(32),
    wrappedSeed: wrapped.wrappedSeed,
    wrapNonce: wrapped.wrapNonce,
    wrapTag: wrapped.wrapTag,
    kekId: wrapped.kekId,
    status: "current",
    createdAt: new Date(NOW_MS),
    activatedAt: new Date(NOW_MS),
    retiredAt: null,
  };
}

describe("keyring callbacks", () => {
  it("should expose the current and named keys only inside callbacks", async () => {
    const keyring = await keyringFixture();
    try {
      expect(keyring.currentId).toBe("k1");
      const current = keyring.withCurrentKey((key) => Buffer.from(key));
      const named = keyring.withKey("k2", (key) => Buffer.from(key));
      expect(current).toHaveLength(32);
      expect(named).toHaveLength(32);
      expect(current.equals(named)).toBe(false);
      expect(() => keyring.withKey("missing", () => undefined)).toThrow(KeyringError);
    } finally {
      keyring.destroy();
    }
  });

  it("should reject callbacks after destruction", async () => {
    const keyring = await keyringFixture();
    keyring.destroy();
    keyring.destroy();

    expect(keyring.currentId).toBeUndefined();
    expect(() => keyring.withCurrentKey(() => undefined)).toThrow(KeyringError);
    expect(() => keyring.withKey("k1", () => undefined)).toThrow(KeyringError);
  });
});

describe("Ed25519 key generation", () => {
  it("should return ULID identifiers and 32-byte key material", () => {
    const first = generateSigningKey(NOW_MS);
    const second = generateSigningKey(NOW_MS);
    try {
      expect(isUlid(first.kid)).toBe(true);
      expect(first.kid).not.toBe(second.kid);
      expect(first.seed).toHaveLength(32);
      expect(first.publicKey).toHaveLength(32);
      expect(first.seed.equals(second.seed)).toBe(false);
      expect(first.publicKey.equals(second.publicKey)).toBe(false);
    } finally {
      first.seed.fill(0);
      second.seed.fill(0);
    }
  });
});

describe("wrapped seed handling", () => {
  it("should round-trip a seed and reject a different key identifier", async () => {
    const keyring = await keyringFixture();
    const seed = randomBytes(32);
    try {
      const kid = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
      const wrapped = wrapSigningSeed(keyring, kid, seed);
      const recovered = unwrapSigningSeed(keyring, rowFromWrapped(kid, wrapped));
      try {
        expect(recovered.equals(seed)).toBe(true);
      } finally {
        recovered.fill(0);
      }

      const wrongKid = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
      expect(() => unwrapSigningSeed(keyring, rowFromWrapped(wrongKid, wrapped))).toThrow(
        SigningKeyUnavailableError,
      );
    } finally {
      seed.fill(0);
      keyring.destroy();
    }
  });

  it("should reject malformed seeds, nonces, tags, and wrong KEKs", async () => {
    const keyring = await keyringFixture();
    try {
      expect(() =>
        wrapSigningSeed(keyring, "01ARZ3NDEKTSV4RRFFQ69G5FAX", Buffer.alloc(31)),
      ).toThrow(SigningKeyUnavailableError);

      const kid = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
      const valid = wrapSigningSeed(keyring, kid, randomBytes(32));
      expect(() =>
        unwrapSigningSeed(keyring, {
          ...rowFromWrapped(kid, valid),
          wrappedSeed: Buffer.alloc(31),
        }),
      ).toThrow(SigningKeyUnavailableError);
      expect(() =>
        unwrapSigningSeed(keyring, {
          ...rowFromWrapped(kid, valid),
          wrapNonce: Buffer.alloc(11),
        }),
      ).toThrow(SigningKeyUnavailableError);
      expect(() =>
        unwrapSigningSeed(keyring, {
          ...rowFromWrapped(kid, valid),
          wrapTag: Buffer.alloc(15),
        }),
      ).toThrow(SigningKeyUnavailableError);
      expect(() =>
        unwrapSigningSeed(keyring, {
          ...rowFromWrapped(kid, valid),
          kekId: "k2",
        }),
      ).toThrow(SigningKeyUnavailableError);
    } finally {
      keyring.destroy();
    }
  });
});

describe("signing-key service cache", () => {
  it("should re-ensure after destroy and still verify an earlier token", async () => {
    if (testDb === undefined) {
      throw new Error("test database is not ready");
    }
    const keyring = await keyringFixture();
    try {
      const service = new SigningKeyService({
        repository: new SigningKeyRepository(testDb.db),
        keyring,
        now: () => nowMs,
      });
      await service.ensure();
      const issued = await service.signAccessToken({
        principalId: PRINCIPAL_ID,
        familyId: FAMILY_ID,
        nowMs,
      });

      service.destroy();
      await expect(service.verifyAccessToken(issued.token)).resolves.toMatchObject({
        sub: PRINCIPAL_ID,
        sid: FAMILY_ID,
      });

      const reissued = await service.signAccessToken({
        principalId: PRINCIPAL_ID,
        familyId: FAMILY_ID,
        nowMs,
      });
      expect(reissued.token).not.toBe(issued.token);
    } finally {
      keyring.destroy();
      await testDb.db.executeQuery("DELETE FROM signing_keys");
    }
  });

  it("should expose the documented overlap constant", () => {
    expect(SIGNING_KEY_OVERLAP_MS).toBe(930_000);
  });
});
