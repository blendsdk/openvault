import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuditRateLimitService } from "../../src/audit/audit-rate-limits.js";

describe("audit rate limits", () => {
  it("should limit each bucket separately and use the configured threshold", async () => {
    const limits = createAuditRateLimitService({ eventLimit: 1, verifyLimit: 1, exportLimit: 1 });
    const app = express();
    app.get("/events", limits.events, (_req, res) => {
      res.status(200).send("ok");
    });
    app.get("/verify", limits.verify, (_req, res) => {
      res.status(200).send("ok");
    });
    app.get("/export", limits.export, (_req, res) => {
      res.status(200).send("ok");
    });

    expect((await request(app).get("/events")).status).toBe(200);
    expect((await request(app).get("/events")).status).toBe(429);
    expect((await request(app).get("/verify")).status).toBe(200);
    expect((await request(app).get("/verify")).status).toBe(429);
    expect((await request(app).get("/export")).status).toBe(200);
    expect((await request(app).get("/export")).status).toBe(429);
  });
});
