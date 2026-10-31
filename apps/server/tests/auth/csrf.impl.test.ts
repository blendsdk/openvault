import { ApiError } from "blendsdk/webafx";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfGuard } from "../../src/auth/csrf.js";
import { SessionService } from "../../src/auth/sessions.js";
import type { SessionRecord } from "../../src/auth/types.js";
import { loadConfig, type OpenVaultConfig } from "../../src/config/index.js";
import { type ConfigFixture, createConfigFixture } from "../helpers/config-fixture.js";

const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({ success: false, error: { code: error.code } });
    return;
  }
  next(error);
}

function attach(record: SessionRecord): express.RequestHandler {
  return (req, _res, next) => {
    req.auth = {
      session: record,
      user: {
        id: record.principalId,
        name: "CSRF Tester",
        email: "csrf@example.test",
        authMethod: record.authMethod,
      },
      mustChangePassword: false,
    };
    next();
  };
}

let fixture: ConfigFixture;
let config: OpenVaultConfig;

beforeAll(() => {
  fixture = createConfigFixture();
  config = loadConfig(fixture.env);
});

afterAll(() => {
  fixture.cleanup();
});

describe("csrfGuard implementation", () => {
  it("should reject a session revoked between middleware and the mutation", async () => {
    const cache = new MemoryCacheProvider({ rootKey: "openvault-csrf-impl" });
    const sessions = new SessionService({ config, cache, sweepIntervalMs: 0 });
    try {
      const created = await sessions.create({ principalId: PRINCIPAL, authMethod: "local" });
      const app = express();
      app.use(attach(created.record));
      app.use(csrfGuard(sessions));
      app.post("/mutate", (_req, res) => res.status(204).end());
      app.use(errorHandler);

      await sessions.revoke(created.record.publicId, PRINCIPAL);

      const response = await request(app)
        .post("/mutate")
        .set("x-csrf-token", created.record.csrfToken);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "authentication_required" },
      });
    } finally {
      await sessions.destroy();
    }
  });
});
