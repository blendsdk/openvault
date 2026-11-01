import type { Logger } from "blendsdk/webafx";
import { describe, expect, it } from "vitest";
import type { LocalCredential } from "../../src/auth/credentials.js";
import {
  isLocked,
  type LocalLoginCredentials,
  LocalLoginService,
  normalizeIdentifier,
} from "../../src/auth/local-login.js";

const TEST_PASSWORD = "correct horse battery staple";
const TEST_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";

interface FakeState {
  credential?: LocalCredential;
  failureCalls: number;
  successCalls: number;
  successResult: boolean;
}

class FakeCredentials implements LocalLoginCredentials {
  public readonly state: FakeState;

  public constructor(state: Partial<FakeState> = {}) {
    this.state = {
      failureCalls: 0,
      successCalls: 0,
      successResult: true,
      ...state,
    };
  }

  public async findByIdentifier(): Promise<LocalCredential | undefined> {
    return this.state.credential;
  }

  public async findByPrincipalId(): Promise<LocalCredential | undefined> {
    return this.state.credential;
  }

  public async recordFailure(): Promise<{ failedCount: number; lockedUntil: Date | null }> {
    this.state.failureCalls += 1;
    return { failedCount: this.state.failureCalls, lockedUntil: null };
  }

  public async recordSuccess(): Promise<boolean> {
    this.state.successCalls += 1;
    return this.state.successResult;
  }
}

function credential(overrides: Partial<LocalCredential> = {}): LocalCredential {
  return {
    principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    name: "Local User",
    email: "local@example.test",
    status: "active",
    passwordHash: TEST_PASSWORD_HASH,
    mustChange: false,
    failedCount: 0,
    lockedUntil: null,
    updatedAt: new Date(1_700_000_000_000),
    ...overrides,
  };
}

function logger(warnings: string[]): Logger {
  return {
    info: async () => undefined,
    error: async () => undefined,
    warn: async (message) => {
      warnings.push(message);
    },
    debug: async () => undefined,
  };
}

describe("identifier normalization and lock state", () => {
  it("should trim and lowercase an identifier", () => {
    expect(normalizeIdentifier("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeIdentifier("")).toBe("");
  });

  it("should treat only a future lock as active", () => {
    const now = Date.now();
    expect(isLocked(new Date(now + 1_000), now)).toBe(true);
    expect(isLocked(new Date(now), now)).toBe(false);
    expect(isLocked(null, now)).toBe(false);
  });
});

describe("shared local login", () => {
  it("should reject an unknown credential without touching counters", async () => {
    const credentials = new FakeCredentials();
    const result = await new LocalLoginService({ credentials }).login({
      identifier: "missing@example.test",
      password: TEST_PASSWORD,
    });

    expect(result).toEqual({ ok: false });
    expect(credentials.state.failureCalls).toBe(0);
    expect(credentials.state.successCalls).toBe(0);
  });

  it("should reject a disabled or locked credential generically", async () => {
    for (const state of [
      credential({ status: "disabled" }),
      credential({ lockedUntil: new Date(Date.now() + 60_000), failedCount: 5 }),
    ]) {
      const credentials = new FakeCredentials({ credential: state });
      await expect(
        new LocalLoginService({ credentials }).login({
          identifier: "local@example.test",
          password: TEST_PASSWORD,
        }),
      ).resolves.toEqual({ ok: false });
      expect(credentials.state.failureCalls).toBe(0);
      expect(credentials.state.successCalls).toBe(0);
    }
  });

  it("should reject an out-of-policy stored hash and log only the principal id", async () => {
    const warnings: string[] = [];
    const credentials = new FakeCredentials({
      credential: credential({ passwordHash: "$argon2id$bad" }),
    });
    const result = await new LocalLoginService({ credentials }).login(
      { identifier: "local@example.test", password: TEST_PASSWORD },
      logger(warnings),
    );

    expect(result).toEqual({ ok: false });
    expect(warnings).toEqual(["stored password hash rejected"]);
    expect(credentials.state.failureCalls).toBe(0);
  });

  it("should increment the failure counter only for a real wrong password", async () => {
    const credentials = new FakeCredentials({ credential: credential() });
    const result = await new LocalLoginService({ credentials }).login({
      identifier: "local@example.test",
      password: "wrong password",
    });

    expect(result).toEqual({ ok: false });
    expect(credentials.state.failureCalls).toBe(1);
    expect(credentials.state.successCalls).toBe(0);
  });

  it("should return the verified fields and reset counters on success", async () => {
    const credentials = new FakeCredentials({ credential: credential({ mustChange: true }) });
    const result = await new LocalLoginService({ credentials }).login({
      identifier: "  LOCAL@EXAMPLE.TEST ",
      password: TEST_PASSWORD,
    });

    expect(result).toEqual({
      ok: true,
      credential: {
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        name: "Local User",
        email: "local@example.test",
        mustChange: true,
        passwordHash: TEST_PASSWORD_HASH,
      },
    });
    expect(credentials.state.successCalls).toBe(1);
    expect(credentials.state.failureCalls).toBe(0);
  });

  it("should report a lost success compare-and-swap as a generic failure", async () => {
    const credentials = new FakeCredentials({
      credential: credential(),
      successResult: false,
    });
    await expect(
      new LocalLoginService({ credentials }).login({
        identifier: "local@example.test",
        password: TEST_PASSWORD,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("should revalidate only an unchanged stored hash", async () => {
    const credentials = new FakeCredentials({ credential: credential() });
    const service = new LocalLoginService({ credentials });
    await expect(
      service.revalidate("01ARZ3NDEKTSV4RRFFQ69G5FAV", TEST_PASSWORD_HASH),
    ).resolves.toBe(true);

    credentials.state.credential = credential({ passwordHash: "$argon2id$changed" });
    await expect(
      service.revalidate("01ARZ3NDEKTSV4RRFFQ69G5FAV", TEST_PASSWORD_HASH),
    ).resolves.toBe(false);
  });
});
