import { decryptValue, encryptValue } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyringProvider } from "../../src/security/keyring.js";
import { createServerEnvironment } from "./helpers/server-environment.js";

let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;

beforeAll(async () => {
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
});

afterAll(() => {
  keyring.destroy();
  environment.cleanup();
});

describe("KeyringProvider envelope port", () => {
  it("should encrypt and decrypt through the provider", () => {
    const aad = {
      objectType: "secret" as const,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      objectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      version: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    };
    const envelope = encryptValue(Buffer.from("provider-value"), keyring, aad);
    expect(
      decryptValue(envelope, keyring, aad, { maxCiphertextBytes: 65_536 }).toString("utf8"),
    ).toBe("provider-value");
    expect(keyring.destroyed).toBe(false);
  });
});
