import { RateLimitError } from "blendsdk/webafx";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAgentRateLimitService } from "../../src/agent/agent-rate-limits.js";

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof RateLimitError) {
    res.status(429).json({ code: error.code });
    return;
  }
  next(error);
}

function agentApp(): express.Express {
  const service = createAgentRateLimitService({
    joinLimit: 2,
    renewPrincipalLimit: 2,
    renewIpLimit: 3,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.agent = {
      kind: "agent",
      principalId: req.header("x-principal") ?? "principal-1",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      projectName: "project",
      certificateId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      serial: "01",
      fingerprint: "a".repeat(64),
      publicKeySha256: "b".repeat(64),
      notAfter: Date.now() + 86_400_000,
    };
    next();
  });
  app.post("/join", service.joinIp, (_req, res) => res.status(204).end());
  app.post("/renew", service.renewPrincipal, service.renewIp, (_req, res) => res.status(204).end());
  app.use(errorHandler);
  return app;
}

describe("agent rate limits", () => {
  it("should limit joins per source address", async () => {
    const app = agentApp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(request(app).post("/join")).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(app).post("/join");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ code: "RATE_LIMIT_EXCEEDED" });
  });

  it("should limit renewals per principal without resetting on request changes", async () => {
    const app = agentApp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        request(app).post("/renew").set("x-principal", "principal-a"),
      ).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(app)
      .post("/renew")
      .set("x-principal", "principal-a")
      .set("x-csr", "rotated");
    expect(limited.status).toBe(429);

    await expect(
      request(app).post("/renew").set("x-principal", "principal-b"),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("should limit renewals per source address across principals", async () => {
    const app = agentApp();
    for (const principal of ["p1", "p2", "p3"]) {
      await expect(
        request(app).post("/renew").set("x-principal", principal),
      ).resolves.toMatchObject({ status: 204 });
    }
    const limited = await request(app).post("/renew").set("x-principal", "p4");
    expect(limited.status).toBe(429);
  });
});
