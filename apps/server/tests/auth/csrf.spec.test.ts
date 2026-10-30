import { ApiError } from "blendsdk/webafx";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { csrfGuard, originGuard } from "../../src/auth/csrf.js";
import { type SessionRecord, SessionService } from "../../src/auth/sessions.js";
import { loadConfig, type OpenVaultConfig } from "../../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "../helpers/config-fixture.js";

const SESSION_COOKIE = "__Host-ov_session";
const CONFIGURED_ORIGIN = "https://vault.example.com";
const CSRF_HEADER = "x-csrf-token";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string() }),
});

interface GuardApp {
  readonly app: express.Express;
  readonly calls: () => number;
}

let config: OpenVaultConfig;
let fixture: ConfigFixture;
let sessions: SessionService;
let record: SessionRecord;
let secretId: string;

/** Renders an ApiError the same way the production envelope does for status and code. */
function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, statusCode: error.statusCode },
    });
    return;
  }
  next(error);
}

/** Attaches the already-resolved authenticated context to a synthetic request. */
function attachAuth(session: SessionRecord): express.RequestHandler {
  return (req, _res, next) => {
    Object.assign(req, {
      auth: {
        session,
        user: {
          id: session.principalId,
          name: "Session Tester",
          email: "session-tester@example.test",
          authMethod: session.authMethod,
        },
        mustChangePassword: false,
      },
    });
    next();
  };
}

/** Builds a minimal app that applies only the origin guard to unsafe methods. */
function createOriginApp(): GuardApp {
  const app = express();
  let calls = 0;
  app.use(attachAuth(record));
  app.use(originGuard(config));
  app.post("/mutate", (_req, res) => {
    calls += 1;
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    calls += 1;
    res.status(204).end();
  });
  app.use(errorHandler);
  return { app, calls: () => calls };
}

/**
 * Builds a minimal app that applies only the CSRF guard.
 *
 * When `auth` is omitted the request has no resolved session, which models a
 * bearer or machine route that must not be blocked by cookie CSRF rules.
 */
function createCsrfApp(auth: SessionRecord | undefined): GuardApp {
  const app = express();
  let calls = 0;
  if (auth !== undefined) {
    app.use(attachAuth(auth));
  }
  app.use(csrfGuard(sessions));
  app.post("/mutate", (_req, res) => {
    calls += 1;
    if (auth === undefined) {
      res.status(401).json({
        success: false,
        error: { code: "authentication_required", message: "Authentication required" },
      });
      return;
    }
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    calls += 1;
    res.status(204).end();
  });
  app.use(errorHandler);
  return { app, calls: () => calls };
}

/** Headers for a browser request that carries the session cookie and CSRF token. */
function browserHeaders(includeToken = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${secretId}`,
    ...(includeToken ? { [CSRF_HEADER]: record.csrfToken } : {}),
  };
}

beforeAll(async () => {
  fixture = createConfigFixture();
  config = loadConfig(fixture.env);
  const cache = new MemoryCacheProvider({ rootKey: "openvault-csrf-spec" });
  sessions = new SessionService({ config, cache, sweepIntervalMs: 60_000 });
  const created = await sessions.create({
    principalId: PRINCIPAL_ID,
    authMethod: "local",
  });
  secretId = created.secretId;
  record = created.record;
});

afterAll(async () => {
  await sessions.destroy();
  fixture.cleanup();
});

describe("origin guard", () => {
  it("should reject an unsafe request when the Origin does not match the configured origin", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app)
      .post("/mutate")
      .set({
        ...browserHeaders(),
        origin: "https://evil.example",
      });
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe("csrf_invalid");
    expect(guard.calls()).toBe(0);
  });

  it("should allow an unsafe request when the Origin equals the configured origin", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app)
      .post("/mutate")
      .set({
        ...browserHeaders(),
        origin: CONFIGURED_ORIGIN,
      });

    expect(response.status).toBe(204);
    expect(guard.calls()).toBe(1);
  });

  it("should allow an unsafe request when Sec-Fetch-Site is same-origin without an Origin", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app)
      .post("/mutate")
      .set({
        ...browserHeaders(),
        "sec-fetch-site": "same-origin",
      });

    expect(response.status).toBe(204);
    expect(guard.calls()).toBe(1);
  });

  it("should reject an unsafe request when Sec-Fetch-Site is same-site", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app)
      .post("/mutate")
      .set({
        ...browserHeaders(),
        "sec-fetch-site": "same-site",
      });
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe("csrf_invalid");
    expect(guard.calls()).toBe(0);
  });

  it("should reject an unsafe request when both Origin and Sec-Fetch-Site are absent", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app).post("/mutate").set(browserHeaders());
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe("csrf_invalid");
    expect(guard.calls()).toBe(0);
  });

  it("should leave safe methods alone even when the Origin is foreign", async () => {
    const guard = createOriginApp();

    const response = await request(guard.app).get("/read").set({ origin: "https://evil.example" });

    expect(response.status).toBe(204);
    expect(guard.calls()).toBe(1);
  });
});

describe("CSRF token guard", () => {
  it("should reject an unsafe request that omits the CSRF header even when the session is valid", async () => {
    const guard = createCsrfApp(record);

    const response = await request(guard.app).post("/mutate").set(browserHeaders(false));
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe("csrf_invalid");
    expect(guard.calls()).toBe(0);
  });

  it("should reject an unsafe request with a wrong CSRF token", async () => {
    const guard = createCsrfApp(record);

    const response = await request(guard.app)
      .post("/mutate")
      .set({
        ...browserHeaders(false),
        [CSRF_HEADER]: `${record.csrfToken.slice(0, -1)}x`,
      });
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe("csrf_invalid");
    expect(guard.calls()).toBe(0);
  });

  it("should allow an unsafe request with the session CSRF token", async () => {
    const guard = createCsrfApp(record);

    const response = await request(guard.app).post("/mutate").set(browserHeaders());

    expect(response.status).toBe(204);
    expect(guard.calls()).toBe(1);
  });

  it("should leave safe methods alone without a CSRF token", async () => {
    const guard = createCsrfApp(record);

    const response = await request(guard.app).get("/read").set(browserHeaders(false));

    expect(response.status).toBe(204);
    expect(guard.calls()).toBe(1);
  });

  it("should pass a bearer request without a session cookie through to route authentication", async () => {
    const guard = createCsrfApp(undefined);

    const response = await request(guard.app).post("/mutate").set({
      authorization: "Bearer machine-token",
    });
    const parsed = errorEnvelope.parse(response.body);

    expect(response.status).toBe(401);
    expect(parsed.error.code).toBe("authentication_required");
    expect(guard.calls()).toBe(1);
  });
});
