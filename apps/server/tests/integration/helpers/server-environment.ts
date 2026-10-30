import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OpenVaultConfig } from "../../../src/config/index.js";
import { createTlsFixture, type TlsFixture } from "./tls.js";

/** A complete runtime environment backed by disposable files. */
export interface ServerEnvironment {
  /** Validated configuration for the server. */
  readonly config: OpenVaultConfig;
  /** Environment values that produced the configuration. */
  readonly env: NodeJS.ProcessEnv;
  /** Generated TLS material. */
  readonly tls: TlsFixture;
  /** Absolute keyring path. */
  readonly keyringPath: string;
  cleanup(): void;
}

const KEY_BYTES = 32;

/**
 * Creates a complete valid server environment for integration tests.
 *
 * The database URL defaults to a closed local port so an accidental probe fails
 * fast instead of reaching a shared server. Pass an explicit URL for readiness
 * tests that need a live database.
 *
 * @param overrides - Environment values that replace the defaults.
 * @returns Configuration, paths, and a cleanup function.
 */
export function createServerEnvironment(overrides: NodeJS.ProcessEnv = {}): ServerEnvironment {
  const tls = createTlsFixture();
  const keyringDirectory = mkdtempSync(join(tmpdir(), "openvault-keyring-"));
  const keyringPath = join(keyringDirectory, "keyring.json");
  writeFileSync(
    keyringPath,
    JSON.stringify({
      version: 1,
      current: "k1",
      keys: { k1: Buffer.alloc(KEY_BYTES, 5).toString("base64") },
    }),
    { mode: 0o600 },
  );
  chmodSync(keyringPath, 0o600);

  const env: NodeJS.ProcessEnv = {
    OPENVAULT_BASE_URL: "https://vault.example.com",
    OPENVAULT_DB_URL: "postgres://openvault:test-password@127.0.0.1:59999/openvault_test",
    OPENVAULT_KEYRING: keyringPath,
    OPENVAULT_TLS_CERT: tls.serverCertPath,
    OPENVAULT_TLS_KEY: tls.serverKeyPath,
    OPENVAULT_INTERNAL_CA: tls.caPath,
    OPENVAULT_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    ...overrides,
  };

  return {
    config: loadConfig(env),
    env,
    tls,
    keyringPath,
    cleanup(): void {
      rmSync(keyringDirectory, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}
