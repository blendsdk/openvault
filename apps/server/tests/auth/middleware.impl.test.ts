import { ApiError } from "blendsdk/webafx";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  passwordChangeGate,
  requireSession,
  sessionMiddleware,
} from "../../src/auth/middleware.js";
import type { AuthContext, PrincipalStatus } from "../../src/auth/types.js";

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
    app.use(errorHandler);

    for (const requestBuilder of [
      request(app).get("/v1/auth/me"),
      request(app).post("/v1/auth/password"),
      request(app).post("/v1/auth/logout"),
      request(app).get("/v1/meta/auth"),
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
      hasRecentRotation: (): boolean => false,
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
});
