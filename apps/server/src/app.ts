import { WebApplication } from "blendsdk/webafx";
import { ReadyController } from "./controllers/ready.js";

/** Supported WebAFX environment modes. */
export type EnvMode = "production" | "development" | "test";

/** Options used by tests and the process entry point. */
export interface CreateAppOptions {
  /** HTTP port. Defaults to `PORT` or 8443. */
  readonly PORT?: number;
  /** WebAFX environment mode. Defaults to `production`. */
  readonly ENV_MODE?: EnvMode;
}

function resolveEnvMode(value: string | undefined): EnvMode {
  return value === "development" || value === "test" ? value : "production";
}

/**
 * Builds the WebAFX application without starting the HTTP server.
 *
 * Keeping construction separate makes controller tests fast and lets the process entry
 * point own the listen and shutdown lifecycle.
 */
export function createApp(options: CreateAppOptions = {}): WebApplication {
  const app = new WebApplication({
    PORT: options.PORT ?? Number(process.env.PORT ?? 8443),
    ENV_MODE: options.ENV_MODE ?? resolveEnvMode(process.env.ENV_MODE),
  });

  app.registerController("/v1", ReadyController);
  return app;
}
