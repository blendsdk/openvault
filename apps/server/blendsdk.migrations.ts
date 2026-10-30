import { defineMigrationConfig } from "blendsdk/codegen";

/**
 * BlendSDK migration configuration for the OpenVault server.
 *
 * The desired schema is authored in `src/database/schema.ts`. Manual migrations are used
 * only for objects the relational model cannot express, such as audit triggers and the
 * organization seed.
 */
export default defineMigrationConfig({
  schema: "./src/database/schema.ts",
  migrationsDir: "./migrations",
  databaseUrlEnv: "OPENVAULT_DB_URL",
});
