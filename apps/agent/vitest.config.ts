import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
