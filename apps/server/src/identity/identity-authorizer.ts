import type { Logger } from "blendsdk/webafx";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { LoggingPolicyAudit } from "../rbac/audit.js";
import { PolicyRepository } from "../rbac/policy-repository.js";
import {
  type AuthorizeOptions,
  type PolicyDecision,
  type PolicyResource,
  PolicyService,
} from "../rbac/policy-service.js";
import type { QueryExecutor } from "./identity-repository.js";

/** Identity actions understood by the administrative API. */
export type IdentityAction =
  | "identity.create"
  | "identity.read"
  | "identity.revoke"
  | "identity.join_token";

const silentLogger: Logger = {
  info: async () => undefined,
  error: async () => undefined,
  warn: async () => undefined,
  debug: async () => undefined,
};

/**
 * Identity-authorization adapter used by the administrative service.
 *
 * The full policy engine owns the matrix and scope rules. This class keeps the
 * narrow method shape that the identity service already calls, so the admin API
 * does not change when the policy engine replaces the former helper.
 */
export class IdentityAuthorizer {
  readonly #policy: PolicyService;

  /**
   * @param database - Database or transaction executor.
   * @param policy - Optional shared policy service; production passes the app service.
   */
  public constructor(database: QueryExecutor, policy?: PolicyService) {
    this.#policy =
      policy ??
      new PolicyService({
        repository: new PolicyRepository(database),
        // Direct construction is used by narrow tests; production always passes
        // the application policy service with its real logger.
        audit: new LoggingPolicyAudit(silentLogger),
      });
  }

  /**
   * Checks one identity action against a service identity's owner project.
   *
   * @param action - Identity action.
   * @param actorId - Signed-in user principal.
   * @param projectId - Target identity owner project.
   * @param context - Optional request metadata.
   * @returns True when the action is covered.
   */
  public async can(
    action: IdentityAction,
    actorId: string,
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<boolean> {
    const resource: Extract<PolicyResource, { type: "project" }> = {
      type: "project",
      id: projectId,
    };
    return (await this.#policy.authorize(actorId, action, resource, context)).allowed;
  }

  /**
   * Evaluates one action on one resource and returns the decision.
   *
   * @param action - Identity action.
   * @param actorId - Signed-in user principal.
   * @param resource - Resource being evaluated.
   * @param context - Optional request metadata.
   * @param options - Audit control for a visibility-only call.
   * @returns The decision.
   */
  public async decide(
    action: IdentityAction,
    actorId: string,
    resource: PolicyResource,
    context?: PolicyAuditContext,
    options?: AuthorizeOptions,
  ): Promise<PolicyDecision> {
    return this.#policy.authorize(actorId, action, resource, context, options ?? {});
  }

  /**
   * Reports whether the actor holds an identity action somewhere.
   *
   * @param action - Identity action.
   * @param actorId - Signed-in user principal.
   * @param context - Optional request metadata.
   * @param options - Audit control for a visibility-only call.
   * @returns True when at least one assignment covers the action.
   */
  public async hasAny(
    action: IdentityAction,
    actorId: string,
    context?: PolicyAuditContext,
    options?: AuthorizeOptions,
  ): Promise<boolean> {
    return (await this.#policy.hasAny(actorId, action, context, options)).allowed;
  }

  /**
   * Reports whether an org-scoped read assignment covers every project.
   *
   * @param actorId - Signed-in user principal.
   * @returns True for org-scoped admin, project-admin, or auditor.
   */
  public async canReadAll(actorId: string): Promise<boolean> {
    return (
      await this.#policy.authorize(
        actorId,
        "identity.read",
        { type: "org", id: "org" },
        undefined,
        { audit: false },
      )
    ).allowed;
  }

  /**
   * Returns the projects covered by project-scoped read assignments.
   *
   * @param actorId - Signed-in user principal.
   * @returns Unique project identifiers.
   */
  public async readableProjectIds(actorId: string): Promise<readonly string[]> {
    return this.#policy.readableProjectIds(actorId, "identity.read");
  }

  /**
   * Resolves the list visibility and records one list decision.
   *
   * @param actorId - Signed-in user principal.
   * @param context - Optional request metadata.
   * @returns All/project visibility, or undefined when the list is denied.
   */
  public async readScope(
    actorId: string,
    context?: PolicyAuditContext,
  ): Promise<
    | { readonly kind: "all" }
    | { readonly kind: "projects"; readonly projectIds: readonly string[] }
    | undefined
  > {
    const result = await this.#policy.authorizeList(
      actorId,
      "identity.read",
      { type: "org", id: "org" },
      context,
    );
    return result.decision.allowed ? result.visibility : undefined;
  }
}
