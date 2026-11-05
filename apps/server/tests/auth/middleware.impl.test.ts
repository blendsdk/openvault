import { ApiError } from "blendsdk/webafx";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  passwordChangeGate,
  requireCli,
  requirePrincipal,
  requireSession,
  sessionMiddleware,
} from "../../src/auth/middleware.js";
import type { AuthContext, CliAuthContext, PrincipalStatus } from "../../src/auth/types.js";

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({ success: false, error: { code: error.code } });
    return;
  }
  next(error);
}

function attach(auth: AuthContext | undefined): express.RequestHandler {
  return (req, _res, next) => {
    if (auth !== undefined) {
      req.auth = auth;
    }
    next();
  };
}

function context(mustChangePassword: boolean): AuthContext {
  return {
    kind: "browser",
    session: {
      publicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      csrfToken: "csrf",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_028_800_000,
      authMethod: "local",
    },
    user: {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      name: "Test User",
      email: "test@example.test",
      authMethod: "local",
    },
    mustChangePassword,
  };
}

function cliContext(mustChangePassword: boolean): CliAuthContext {
  return {
    kind: "cli",
    principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    familyId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    jti: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    expiresAt: 1_700_000_900_000,
    user: {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      name: "CLI User",
      email: "cli@example.test",
      authMethod: "local",
    },
    mustChangePassword,
  };
}

describe("auth middleware implementation", () => {
  it("should reject a missing context from requireSession", async () => {
    const app = express();
    app.get("/probe", (req, res, next) => {
      try {
        requireSession(req);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    const response = await request(app).get("/probe");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: { code: "authentication_required" },
    });
  });

  it("should let an unauthenticated request through the forced-change gate", async () => {
    const app = express();
    app.use(passwordChangeGate());
    app.get("/v1/auth/sessions", (_req, res) => res.status(204).end());
    app.use(errorHandler);

    const response = await request(app).get("/v1/auth/sessions");
    expect(response.status).toBe(204);
  });

  it("should allow the forced-change allowlist and block other routes", async () => {
    const app = express();
    app.use(attach(context(true)));
    app.use(passwordChangeGate());
    app.get("/v1/auth/me", (_req, res) => res.status(204).end());
    app.post("/v1/auth/password", (_req, res) => res.status(204).end());
    app.post("/v1/auth/logout", (_req, res) => res.status(204).end());
    app.get("/v1/meta/auth", (_req, res) => res.status(204).end());
    app.post("/v1/meta/auth", (_req, res) => res.status(204).end());
    app.get("/v1/auth/sessions", (_req, res) => res.status(204).end());
    app.get("/change-password", (_req, res) => res.status(204).end());
    app.get("/assets/app.js", (_req, res) => res.status(204).end());
    app.use(errorHandler);

    for (const requestBuilder of [
      request(app).get("/v1/auth/me"),
      request(app).post("/v1/auth/password"),
      request(app).post("/v1/auth/logout"),
      request(app).get("/v1/meta/auth"),
      request(app).get("/change-password"),
      request(app).get("/assets/app.js"),
    ]) {
      await expect(requestBuilder).resolves.toMatchObject({ status: 204 });
    }

    const blocked = await request(app).get("/v1/auth/sessions");
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      success: false,
      error: { code: "password_change_required" },
    });

    const blockedMeta = await request(app).post("/v1/meta/auth");
    expect(blockedMeta.status).toBe(403);
    expect(blockedMeta.body).toEqual({
      success: false,
      error: { code: "password_change_required" },
    });
  });

  it("should pass every route when the forced change is complete", async () => {
    const app = express();
    app.use(attach(context(false)));
    app.use(passwordChangeGate());
    app.get("/v1/auth/sessions", (_req, res) => res.status(204).end());
    app.use(errorHandler);

    const response = await request(app).get("/v1/auth/sessions");
    expect(response.status).toBe(204);
  });

  it("should leave a request without a session cookie untouched", async () => {
    const app = express();
    const sessions = {
      get: async (): Promise<undefined> => undefined,
      revoke: async (): Promise<boolean> => false,
    };
    const credentials = {
      findStatus: async (): Promise<PrincipalStatus | undefined> => undefined,
    };
    app.use(sessionMiddleware(sessions, credentials));
    app.get("/probe", (req, res) => res.json({ hasAuth: req.auth !== undefined }));
    app.use(errorHandler);

    const response = await request(app).get("/probe");
    expect(response.body).toEqual({ hasAuth: false });
  });

  it("should never fall back to a cookie when any Authorization header is present", async () => {
    const app = express();
    let lookups = 0;
    const sessions = {
      get: async (): Promise<undefined> => {
        lookups += 1;
        return undefined;
      },
      revoke: async (): Promise<boolean> => false,
    };
    const credentials = {
      findStatus: async (): Promise<PrincipalStatus | undefined> => undefined,
    };
    app.use(sessionMiddleware(sessions, credentials));
    app.get("/probe", (req, res) => res.json({ hasAuth: req.auth !== undefined }));
    app.use(errorHandler);

    const response = await request(app)
      .get("/probe")
      .set("authorization", "Basic dXNlcjpwYXNz")
      .set("cookie", "__Host-ov_session=stale");
    expect(response.body).toEqual({ hasAuth: false });
    expect(lookups).toBe(0);
  });

  it("should keep requireSession browser-only and requirePrincipal open to both contexts", async () => {
    const browserApp = express();
    browserApp.use(attach(cliContext(false)));
    browserApp.get("/probe", (req, res, next) => {
      try {
        requireSession(req);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    });
    browserApp.use(errorHandler);

    const browserResponse = await request(browserApp).get("/probe");
    expect(browserResponse.status).toBe(401);

    const cliApp = express();
    cliApp.use(attach(cliContext(false)));
    cliApp.get("/cli", (req, res, next) => {
      try {
        requireCli(req);
        requirePrincipal(req);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    });
    cliApp.use(errorHandler);

    const cliResponse = await request(cliApp).get("/cli");
    expect(cliResponse.status).toBe(204);
  });

  it("should allow only /cli/me and logout for a forced-change CLI context", async () => {
    const app = express();
    app.use(attach(cliContext(true)));
    app.use(passwordChangeGate());
    app.get("/v1/auth/cli/me", (_req, res) => res.status(204).end());
    app.post("/v1/auth/cli/logout", (_req, res) => res.status(204).end());
    app.get("/v1/auth/cli/sessions", (_req, res) => res.status(204).end());
    app.use(errorHandler);

    await expect(request(app).get("/v1/auth/cli/me")).resolves.toMatchObject({ status: 204 });
    await expect(request(app).post("/v1/auth/cli/logout")).resolves.toMatchObject({ status: 204 });
    const blocked = await request(app).get("/v1/auth/cli/sessions");
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      success: false,
      error: { code: "password_change_required" },
    });
  });
});
