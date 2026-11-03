import { RateLimitError } from "blendsdk/webafx";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRbacRateLimitService } from "../../src/rbac/rate-limits.js";

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof RateLimitError) {
    res.status(429).json({ code: error.code });
    return;
  }
  next(error);
}

function app(): express.Express {
  const limits = createRbacRateLimitService({ writeLimit: 2, readLimit: 2 });
  const server = express();
  server.use((req, _res, next) => {
    req.auth = {
      kind: "browser",
      session: {
        publicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        principalId: req.header("x-principal") ?? "principal-1",
        csrfToken: "csrf",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        authMethod: "local",
      },
      user: {
        id: req.header("x-principal") ?? "principal-1",
        name: "Test",
        email: null,
        authMethod: "local",
      },
      mustChangePassword: false,
    };
    next();
  });
  server.post("/write", limits.assignmentWrite, (_req, res) => res.status(204).end());
  server.get("/read", limits.assignmentRead, (_req, res) => res.status(204).end());
  server.use(errorHandler);
  return server;
}

describe("RBAC admin rate limits", () => {
  it("should limit assignment writes per principal", async () => {
    const server = app();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(request(server).post("/write")).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(server).post("/write");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ code: "RATE_LIMIT_EXCEEDED" });

    await expect(
      request(server).post("/write").set("x-principal", "principal-2"),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("should allow sixty reads and reject the sixty-first with the production limits", async () => {
    const limits = createRbacRateLimitService();
    const server = express();
    server.use((req, _res, next) => {
      req.auth = {
        kind: "browser",
        session: {
          publicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          principalId: "principal-1",
          csrfToken: "csrf",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          authMethod: "local",
        },
        user: { id: "principal-1", name: "Test", email: null, authMethod: "local" },
        mustChangePassword: false,
      };
      next();
    });
    server.get("/read", limits.assignmentRead, (_req, res) => res.status(204).end());
    server.use(errorHandler);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await request(server).get("/read")).status).toBe(204);
    }
    expect((await request(server).get("/read")).status).toBe(429);
  });

  it("should limit assignment reads per principal", async () => {
    const server = app();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(request(server).get("/read")).resolves.toMatchObject({ status: 204 });
    }
    expect((await request(server).get("/read")).status).toBe(429);
    await expect(
      request(server).get("/read").set("x-principal", "principal-3"),
    ).resolves.toMatchObject({ status: 204 });
  });
});
