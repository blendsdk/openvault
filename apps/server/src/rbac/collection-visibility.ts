import type { PolicyAuditContext } from "./audit.js";
import type { PolicyService } from "./policy-service.js";

/**
 * Reports whether a caller can list a project's collection.
 *
 * Existence is disclosed only to callers that can already see the collection
 * or an object inside it. An object-scope assignment does not cover a project
 * resource, so it returns false here; the object authorization path still
 * allows the assigned object.
 *
 * @param options - Policy engine, actor, collection action, project, and context.
 * @returns True when the caller can list the collection.
 */
export async function canListCollection(options: {
  readonly policy: PolicyService;
  readonly actorId: string;
  readonly listAction: "secret.list" | "certificate.list";
  readonly projectId: string;
  readonly context?: PolicyAuditContext;
}): Promise<boolean> {
  const decision = await options.policy.authorize(
    options.actorId,
    options.listAction,
    { type: "project", id: options.projectId },
    options.context,
    { audit: false },
  );
  return decision.allowed;
}
