import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConfigFixture } from "./helpers/config-fixture.js";

describe("ST-33 fail-closed startup", () => {
  it("validates configuration before migrations or a database connection", async () => {
    const fixture = createConfigFixture();
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });

    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP address");
    }

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...fixture.env,
        ENV_MODE: "test",
        OPENVAULT_DB_URL: `postgres://openvault:test-password@127.0.0.1:${address.port}/openvault_test`,
      };
      delete env.OPENVAULT_BASE_URL;

      const serverRoot = fileURLToPath(new URL("../", import.meta.url));
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: serverRoot,
        encoding: "utf8",
        env,
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("OPENVAULT_BASE_URL");
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/migration/i);
      expect(connections).toBe(0);
    } finally {
      fixture.cleanup();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 20_000);
});
