import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SecretRotationWebhook } from "../../../src/secrets/rotation/webhook.js";

const payload = {
  event: "secret.rotation_warning" as const,
  eventId: "secret:version:due_soon:due",
  secretId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  name: "db-password",
  versionId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  dueAt: "2026-12-09T12:00:00.000Z",
  daysUntilDue: 7,
  status: "due_soon" as const,
  occurredAt: "2026-12-02T12:00:00.000Z",
};

describe("rotation webhook implementation", () => {
  it("should time out when the endpoint does not answer", async () => {
    let server: Server | undefined;
    try {
      server = createServer(() => {
        // Deliberately never respond.
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const webhook = new SecretRotationWebhook({
        url: new URL(`http://127.0.0.1:${address.port}/rotation`),
        timeoutMs: 50,
      });
      await expect(webhook.send(payload)).rejects.toThrow();
    } finally {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });

  it("should reject a non-2xx response", async () => {
    let server: Server | undefined;
    try {
      server = createServer((_request, response) => {
        response.statusCode = 503;
        response.end("unavailable");
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const webhook = new SecretRotationWebhook({
        url: new URL(`http://127.0.0.1:${address.port}/rotation`),
      });
      await expect(webhook.send(payload)).rejects.toThrow();
    } finally {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });
});
