import { fileURLToPath } from "node:url";

/**
 * Absolute path to the BlendSDK migration configuration.
 *
 * The path is stable from both `src` and the compiled `dist` tree because the config file
 * lives at the server package root.
 */
export const migrationConfigPath = fileURLToPath(
  new URL("../../blendsdk.migrations.ts", import.meta.url),
);
