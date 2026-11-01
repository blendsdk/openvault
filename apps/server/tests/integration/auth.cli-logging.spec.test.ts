import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLoggerProvider, REDACT_PATHS } from "../../src/observability/logger.js";
import {
  CliAuthTestHarness,
  cliRefreshResponseSchema,
  cliTokenResponseSchema,
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  trustedTestHost,
} from "./helpers/cli.js";
import type { TestResponse } from "./helpers/https.js";
import { MemoryDestination } from "./helpers/memory-destination.js";
import { createServerEnvironment } from "./helpers/server-environment.js";

/** Candidate password sent by a rejected sign-in. */
const REJECTED_PASSWORD = "definitely-not-the-password-and-must-never-be-logged";

/** Key id of the fixture key-encryption key written for the test environment. */
const FIXTURE_KEK_ID = "k1";

/** The fixture key-encryption key is 32 bytes of the same value. */
const FIXTURE_KEK = Buffer.alloc(32, 5);

/** Associated data that binds a wrapped signing seed to its key id. */
const SIGNING_SEED_AAD_PREFIX = "ov:jwt:v1:";

/** A wrapped signing seed stores a 32-byte seed, a 12-byte nonce, and a 16-byte tag. */
const SIGNING_SEED_BYTES = 32;
const SIGNING_KEY_NONCE_BYTES = 12;
const SIGNING_KEY_TAG_BYTES = 16;

/** Route that signs a local credential in for the command line. */
const CLI_LOGIN_PATH = "/v1/auth/cli/login";

/** Route that rotates a command-line refresh token. */
const CLI_REFRESH_PATH = "/v1/auth/cli/refresh";

/** Route that revokes a command-line refresh family. */
const CLI_LOGOUT_PATH = "/v1/auth/cli/logout";

let harness: CliAuthTestHarness | undefined;
let signingSeed: Buffer | undefined;

/**
 * Every raw credential value that must stay out of the captured logs.
 *
 * Values are remembered as each test obtains them. Later tests therefore also
 * re-check earlier credentials against the complete capture.
 */
const sensitiveValues = new Set<string>();

/** Returns the running harness or fails the current test with a clear message. */
function requireHarness(): CliAuthTestHarness {
  if (harness === undefined) {
    throw new Error("the test harness is not ready");
  }
  return harness;
}

/** Adds credential values to the set checked against the captured output. */
function rememberSecrets(...values: readonly (string | undefined)[]): void {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      sensitiveValues.add(value);
    }
  }
}

/**
 * Converts a SHA-256 digest to every textual form a stored hash could leak in.
 *
 * The hash is derived in the test from the raw refresh token, so the assertion
 * does not depend on how the implementation renders binary values.
 */
function refreshHashForms(refreshToken: string): string[] {
  const digest = createHash("sha256").update(refreshToken, "utf8").digest();
  return [
    digest.toString("hex"),
    digest.toString("base64"),
    digest.toString("base64url"),
    JSON.stringify(digest),
  ];
}

/** Remembers a refresh token and its at-rest hash forms. */
function rememberRefreshToken(refreshToken: string): void {
  rememberSecrets(refreshToken, ...refreshHashForms(refreshToken));
}

/** Asserts that no remembered credential appears anywhere in the capture. */
function expectCapturedLogsToBeClean(): void {
  const output = requireHarness().logText();
  for (const value of sensitiveValues) {
    expect(output, "captured logs must not contain a raw credential").not.toContain(value);
  }
}

/**
 * Proves that the capture contains the log entry for one specific response.
 *
 * Without this check a clean assertion could pass only because the request was
 * never logged at all.
 */
function expectRequestCaptured(response: TestResponse, path: string): void {
  const requestId = response.headers["x-request-id"];
  expect(typeof requestId, "the response must carry a request id").toBe("string");
  expect(requireHarness().logs.entries()).toContainEqual(
    expect.objectContaining({ requestId, url: path }),
  );
}

/** Returns true when a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asserts a stable error body and that it carries no credential-shaped field.
 *
 * The public error envelope is limited to a stable code, a stable message, and
 * the HTTP status, so the assertion also rejects any extra detail field that
 * could carry key material. No remembered value may appear in the serialized
 * body either.
 */
function expectStableError(response: TestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  if (!isRecord(response.json) || !isRecord(response.json.error)) {
    throw new Error("expected an error envelope");
  }
  const error = response.json.error;
  expect(response.json.success).toBe(false);
  expect(error.code).toBe(code);
  expect(error.statusCode).toBe(status);
  expect(typeof error.message).toBe("string");
  expect((error.message as string).length).toBeGreaterThan(0);
  // The raw envelope, not a lenient parsed projection, must contain exactly the
  // stable diagnostic fields. An added `details` or `stack` field fails here.
  expect(Object.keys(error).sort()).toEqual([
    "code",
    "message",
    "path",
    "requestId",
    "statusCode",
    "timestamp",
  ]);

  for (const value of sensitiveValues) {
    expect(response.body, "the error body must not contain a raw credential").not.toContain(value);
  }
}

/**
 * Reads the current signing seed from its wrapped row and unwraps it.
 *
 * The wrap format is fixed by the key contract: AES-256-GCM under the current
 * fixture key-encryption key, with the key id as associated data. The test
 * performs the unwrap itself so the assertion is independent of the production
 * unwrap helper.
 */
async function readCurrentSigningSeed(testHarness: CliAuthTestHarness): Promise<Buffer> {
  const result = await testHarness.db.db.executeQuery<{
    kid: string;
    wrapped_seed: Buffer;
    wrap_nonce: Buffer;
    wrap_tag: Buffer;
    kek_id: string;
  }>(
    `SELECT kid, wrapped_seed, wrap_nonce, wrap_tag, kek_id
       FROM signing_keys
      WHERE status = 'current'`,
  );
  const row = result.records[0];
  if (row === undefined) {
    throw new Error("expected a current signing key");
  }

  expect(row.kek_id).toBe(FIXTURE_KEK_ID);
  expect(row.wrapped_seed).toHaveLength(SIGNING_SEED_BYTES);
  expect(row.wrap_nonce).toHaveLength(SIGNING_KEY_NONCE_BYTES);
  expect(row.wrap_tag).toHaveLength(SIGNING_KEY_TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", FIXTURE_KEK, row.wrap_nonce);
  decipher.setAAD(Buffer.from(`${SIGNING_SEED_AAD_PREFIX}${row.kid}`, "utf8"));
  decipher.setAuthTag(row.wrap_tag);
  return Buffer.concat([decipher.update(row.wrapped_seed), decipher.final()]);
}

/**
 * Logs one nested request-body object through the real logger provider.
 *
 * The returned output is the captured sink content, so a caller can assert on
 * what a configured production logger would actually write.
 */
async function captureNestedTokenLog(): Promise<{
  readonly output: string;
  readonly accessValue: string;
  readonly refreshValue: string;
}> {
  const environment = createServerEnvironment();
  const destination = new MemoryDestination();
  const provider = createLoggerProvider(environment.config, destination);
  const accessValue = "nested-access-token-value";
  const refreshValue = "nested-refresh-token-value";

  try {
    await provider.info("nested redaction probe", {
      req: { body: { accessToken: accessValue, refreshToken: refreshValue } },
    });
    await provider.shutdown();
    return { output: destination.lines().join("\n"), accessValue, refreshValue };
  } finally {
    environment.cleanup();
  }
}

/**
 * Logs one nested header object through the real logger provider.
 *
 * @returns Captured output and the raw values that must not appear.
 */
async function captureNestedHeaderLog(): Promise<{
  readonly output: string;
  readonly authorization: string;
  readonly cookie: string;
}> {
  const environment = createServerEnvironment();
  const destination = new MemoryDestination();
  const provider = createLoggerProvider(environment.config, destination);
  const authorization = "Bearer nested-header-token";
  const cookie = "__Host-ov_session=nested-cookie";

  try {
    await provider.info("nested header probe", {
      headers: { authorization, cookie, "set-cookie": "nested-set-cookie" },
    });
    await provider.shutdown();
    return { output: destination.lines().join("\n"), authorization, cookie };
  } finally {
    environment.cleanup();
  }
}

beforeAll(async () => {
  harness = await CliAuthTestHarness.start();
  signingSeed = await readCurrentSigningSeed(harness);
  expect(signingSeed).toHaveLength(SIGNING_SEED_BYTES);
  rememberSecrets(
    signingSeed.toString("hex"),
    signingSeed.toString("base64"),
    signingSeed.toString("base64url"),
    JSON.stringify(signingSeed),
  );
}, 30_000);

afterAll(async () => {
  signingSeed?.fill(0);
  signingSeed = undefined;
  await harness?.stop();
});

describe("nested request-body redaction", () => {
  it("should define redaction paths for nested access and refresh token fields", () => {
    expect(REDACT_PATHS).toContain("req.body.accessToken");
    expect(REDACT_PATHS).toContain("req.body.refreshToken");
    expect(REDACT_PATHS).toContain("*.authorization");
    expect(REDACT_PATHS).toContain("*.cookie");
    expect(REDACT_PATHS).toContain("*.set-cookie");
  });

  it("should mask nested access and refresh token values in real logger output", async () => {
    const { output, accessValue, refreshValue } = await captureNestedTokenLog();

    expect(output).not.toContain(accessValue);
    expect(output).not.toContain(refreshValue);
    expect(output).toContain("[Redacted]");
  });

  it("should mask nested header authorization and cookie values", async () => {
    const { output, authorization, cookie } = await captureNestedHeaderLog();

    expect(output).not.toContain(authorization);
    expect(output).not.toContain(cookie);
    expect(output).not.toContain("nested-set-cookie");
    expect(output).toContain("[Redacted]");
  });
});

describe.skipIf(trustedTestHost === undefined)("captured credential logs", () => {
  it("should keep a valid login's access token, refresh token, password, and refresh hash out of the logs", async () => {
    const user = await requireHarness().insertUser();

    const response = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(response.status).toBe(200);
    const data = cliTokenResponseSchema.parse(response.json).data;

    rememberSecrets(data.accessToken, TEST_PASSWORD);
    rememberRefreshToken(data.refreshToken);

    expectRequestCaptured(response, CLI_LOGIN_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep a rejected login's password out of the logs and return only a stable error", async () => {
    const user = await requireHarness().insertUser();
    rememberSecrets(REJECTED_PASSWORD, TEST_PASSWORD_HASH);

    const response = await requireHarness().cliLogin(user.email, REJECTED_PASSWORD);

    expectStableError(response, 401, "invalid_credentials");
    expectRequestCaptured(response, CLI_LOGIN_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep rotated tokens and their stored hash out of the logs", async () => {
    const user = await requireHarness().insertUser();
    const login = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(login.status).toBe(200);
    const loginData = cliTokenResponseSchema.parse(login.json).data;
    rememberSecrets(loginData.accessToken, TEST_PASSWORD);
    rememberRefreshToken(loginData.refreshToken);

    const response = await requireHarness().cliRefresh(loginData.refreshToken);
    expect(response.status).toBe(200);
    const rotated = cliRefreshResponseSchema.parse(response.json).data;
    rememberSecrets(rotated.accessToken);
    rememberRefreshToken(rotated.refreshToken);

    expectRequestCaptured(response, CLI_REFRESH_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep a malformed refresh token out of the logs and return only a stable error", async () => {
    const malformed = "a".repeat(42);
    rememberRefreshToken(malformed);

    const response = await requireHarness().cliRefresh(malformed);

    expectStableError(response, 400, "validation_error");
    expectRequestCaptured(response, CLI_REFRESH_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep an unknown refresh token out of the logs and return a stable error", async () => {
    const unknown = randomBytes(32).toString("base64url");
    expect(unknown).toHaveLength(43);
    rememberRefreshToken(unknown);

    const response = await requireHarness().cliRefresh(unknown);

    expectStableError(response, 401, "invalid_refresh_token");
    expectRequestCaptured(response, CLI_REFRESH_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep a reused refresh token and the rotated token out of the logs", async () => {
    const user = await requireHarness().insertUser();
    const login = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(login.status).toBe(200);
    const loginData = cliTokenResponseSchema.parse(login.json).data;
    rememberSecrets(loginData.accessToken, TEST_PASSWORD);
    rememberRefreshToken(loginData.refreshToken);

    const rotated = await requireHarness().cliRefresh(loginData.refreshToken);
    expect(rotated.status).toBe(200);
    const rotatedData = cliRefreshResponseSchema.parse(rotated.json).data;
    rememberSecrets(rotatedData.accessToken);
    rememberRefreshToken(rotatedData.refreshToken);

    const reused = await requireHarness().cliRefresh(loginData.refreshToken);
    expectStableError(reused, 401, "invalid_refresh_token");
    expectRequestCaptured(reused, CLI_REFRESH_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep a valid logout's refresh token and hash out of the logs", async () => {
    const user = await requireHarness().insertUser();
    const login = await requireHarness().cliLogin(user.email, TEST_PASSWORD);
    expect(login.status).toBe(200);
    const loginData = cliTokenResponseSchema.parse(login.json).data;
    rememberSecrets(loginData.accessToken, TEST_PASSWORD);
    rememberRefreshToken(loginData.refreshToken);

    const response = await requireHarness().cliLogout(loginData.refreshToken);

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expectRequestCaptured(response, CLI_LOGOUT_PATH);
    expectCapturedLogsToBeClean();
  });

  it("should keep an unknown logout's refresh token and hash out of the logs", async () => {
    const unknown = randomBytes(32).toString("base64url");
    expect(unknown).toHaveLength(43);
    rememberRefreshToken(unknown);

    const response = await requireHarness().cliLogout(unknown);

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expectRequestCaptured(response, CLI_LOGOUT_PATH);
    expectCapturedLogsToBeClean();
  });
});
