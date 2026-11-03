import type { SecureWebApplication } from "../transport/secure-application.js";
import type { AgentRuntime } from "./agent-runtime.js";

/**
 * Starts the agent maintenance scheduler after the application is prepared.
 *
 * The runtime itself is created before transport binding so the CA can fail
 * startup. Maintenance starts only after dependencies and controllers are
 * ready, matching the auth bootstrap lifecycle.
 *
 * @param app - Prepared application with a registered agent runtime.
 */
export async function bootstrapAgentRuntime(app: SecureWebApplication): Promise<void> {
  const runtime = await app.getService<AgentRuntime>("agentRuntime");
  await runtime.maintenance.start();
}
