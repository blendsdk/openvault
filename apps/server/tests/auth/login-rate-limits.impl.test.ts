import { ApiError, RateLimitError } from "blendsdk/webafx";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { accountRateKey, createAuthRateLimitService } from "../../src/auth/login-rate-limits.js";

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof RateLimitError) {
    res.status(429).json({ code: error.code });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({ code: error.code });
    return;
  }
  next(error);
}

function loginApp(): express.Express {
  const service = createAuthRateLimitService();
  const app = express();
  app.use(express.json());
  app.post("/browser", service.loginIp, (_req, res) => res.status(204).end());
  app.post("/cli", service.loginIp, service.loginAccount, (_req, res) => res.status(204).end());
  app.use(errorHandler);
  return app;
}

describe("account rate key", () => {
  it("should normalize, hash, and never contain the email", () => {
    const first = accountRateKey("  Alice@Example.COM ");
    const second = accountRateKey("alice@example.com");

    expect(first).toBe(second);
    expect(first).toMatch(/^account:[0-9a-f]{64}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("example");
  });

  it("should handle a missing or non-string identifier", () => {
    expect(accountRateKey(undefined)).toBe(accountRateKey(""));
    expect(accountRateKey(42)).toBe(accountRateKey(""));
  });
});

describe("shared login limiter instances", () => {
  it("should share the per-address bucket across two routes", async () => {
    const app = loginApp();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(request(app).post("/browser")).resolves.toMatchObject({ status: 204 });
    }
    await expect(
      request(app).post("/cli").send({ identifier: "a@example.test" }),
    ).resolves.toMatchObject({
      status: 204,
    });
    const limited = await request(app).post("/cli").send({ identifier: "b@example.test" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ code: "RATE_LIMIT_EXCEEDED" });
  });

  it("should share the per-account bucket across route instances", async () => {
    const service = createAuthRateLimitService();
    const app = express();
    app.use(express.json());
    app.post("/one", service.loginAccount, (_req, res) => res.status(204).end());
    app.post("/two", service.loginAccount, (_req, res) => res.status(204).end());
    app.use(errorHandler);

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expect(
        request(app).post("/one").send({ identifier: "  Account@Example.test " }),
      ).resolves.toMatchObject({ status: 204 });
    }
    await expect(
      request(app).post("/two").send({ identifier: "account@example.test" }),
    ).resolves.toMatchObject({ status: 204 });
    const limited = await request(app).post("/two").send({ identifier: "ACCOUNT@EXAMPLE.TEST" });
    expect(limited.status).toBe(429);
  });
});

describe("CLI refresh limits", () => {
  it("should limit one address to sixty refresh requests per minute", async () => {
    const service = createAuthRateLimitService();
    const app = express();
    app.post("/refresh", service.refreshIp, (_req, res) => res.status(204).end());
    app.use(errorHandler);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(request(app).post("/refresh")).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(app).post("/refresh");
    expect(limited.status).toBe(429);
  });

  it("should limit thirty successful rotations per family without resetting on token change", async () => {
    const service = createAuthRateLimitService();
    const app = express();
    app.post("/refresh", async (req, res, next) => {
      try {
        const family = typeof req.query.family === "string" ? req.query.family : "family-a";
        await service.consumeRefreshFamily(family, req, res);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(
        request(app).post("/refresh").query({ family: "family-a" }),
      ).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(app).post("/refresh").query({ family: "family-a" });
    expect(limited.status).toBe(429);

    await expect(
      request(app).post("/refresh").query({ family: "family-b" }),
    ).resolves.toMatchObject({ status: 204 });
  });
});
