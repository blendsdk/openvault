import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("ready endpoint", () => {
  it("returns the standard success envelope", async () => {
    const app = createApp({ ENV_MODE: "test", PORT: 0 });
    const shutdown = await app.start();

    try {
      const response = await request(app.express).get("/v1/ready");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, data: { status: "ready" } });
    } finally {
      await shutdown();
    }
  });
});
