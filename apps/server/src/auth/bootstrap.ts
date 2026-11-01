import type { SigningKeyService } from "../security/signing-keys.js";
import type { CliSessionMaintenanceService } from "./cli-maintenance.js";

/** Minimal application surface needed to bootstrap authentication services. */
export interface AuthBootstrapApplication {
  /** Resolves one registered singleton service. */
  getService<T>(name: string): Promise<T>;
}

/**
 * Prepares authentication state that must exist before the server serves traffic.
 *
 * The operation is idempotent: concurrent or repeated starts converge on one
 * current signing key. Due previous keys are retired here as well, so a restart
 * cleans up a completed overlap window even if no rotation follows. CLI session
 * maintenance runs its first bounded cleanup and schedules the daily run; an
 * initial cleanup failure is logged rather than aborting startup.
 *
 * @param app - Prepared application with the auth services registered.
 */
export async function bootstrapAuthRuntime(app: AuthBootstrapApplication): Promise<void> {
  const signingKeys = await app.getService<SigningKeyService>("signingKeys");
  await signingKeys.ensure();
  await signingKeys.retireDue();
  const maintenance = await app.getService<CliSessionMaintenanceService>("cliMaintenance");
  await maintenance.start();
}
