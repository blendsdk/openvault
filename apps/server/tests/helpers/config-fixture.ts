import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A disposable set of files and environment values that satisfy the required
 * configuration contract.
 *
 * Tests use real files because the loader checks path types, readability, and
 * the keyring permission bits. The directory is deleted by {@link cleanup}.
 */
export interface ConfigFixture {
  /** Environment values for a complete, valid configuration. */
  readonly env: NodeJS.ProcessEnv;
  /** Directory that owns every fixture file. */
  readonly directory: string;
  /** Removes the fixture directory and every file inside it. */
  cleanup(): void;
}

const KEYRING_JSON = JSON.stringify({
  version: 1,
  current: "k1",
  keys: { k1: Buffer.alloc(32, 7).toString("base64") },
});

const DUMMY_PEM = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";

/**
 * Writes one fixture file with the requested permission bits.
 *
 * @param directory - Fixture directory.
 * @param name - File name inside the directory.
 * @param contents - File contents.
 * @param mode - Permission bits; defaults to `0600`.
 * @returns Absolute path to the file.
 */
export function writeFixtureFile(
  directory: string,
  name: string,
  contents: string,
  mode = 0o600,
): string {
  const path = join(directory, name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

/**
 * Creates a complete valid environment plus the files it references.
 *
 * @returns A fixture whose `cleanup()` must be called by the test.
 *
 * @example
 * ```ts
 * const fixture = createConfigFixture();
 * try {
 *   const config = loadConfig(fixture.env);
 * } finally {
 *   fixture.cleanup();
 * }
 * ```
 */
export function createConfigFixture(): ConfigFixture {
  const directory = mkdtempSync(join(tmpdir(), "openvault-config-"));
  const keyring = writeFixtureFile(directory, "keyring.json", KEYRING_JSON);
  const cert = writeFixtureFile(directory, "server.crt", DUMMY_PEM);
  const key = writeFixtureFile(directory, "server.key", DUMMY_PEM);
  const ca = writeFixtureFile(directory, "ca.pem", DUMMY_PEM);

  return {
    directory,
    env: {
      OPENVAULT_BASE_URL: "https://vault.example.com",
      OPENVAULT_DB_URL: "postgres://openvault:db-password@localhost:5432/openvault",
      OPENVAULT_KEYRING: keyring,
      OPENVAULT_TLS_CERT: cert,
      OPENVAULT_TLS_KEY: key,
      OPENVAULT_INTERNAL_CA: ca,
    },
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
