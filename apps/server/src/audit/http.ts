import type { IncomingHttpHeaders } from "node:http";
import { ApiError } from "blendsdk/webafx";
import type { LocalLoginResult } from "../auth/local-login.js";
import type { AuditService } from "./audit-service.js";
import { AuditUnavailableError } from "./errors.js";
import type { AuditEventDraft, AuditRequestContext } from "./types.js";

/** The request fields needed for audit metadata. */
export interface AuditRequestLike {
  /** Correlation id assigned by the pre-stack. */
  readonly id?: string | undefined;
  /** Canonical client address, when available. */
  readonly ip?: string | undefined;
  /** Request headers. */
  readonly headers: IncomingHttpHeaders;
}

/**
 * Builds request metadata for audit events.
 *
 * The request id falls back to an internal value because every stored row
 * requires a non-empty correlation id.
 *
 * @param req - Express request or a test double with the same fields.
 * @returns Context accepted by the audit service.
 */
export function auditRequestContext(req: AuditRequestLike): AuditRequestContext {
  return {
    requestId: req.id === undefined ? "internal" : req.id,
    ...(req.ip === undefined ? {} : { sourceIp: req.ip }),
    ...(typeof req.headers["user-agent"] === "string"
      ? { userAgent: req.headers["user-agent"] }
      : {}),
  };
}

/**
 * Maps an audit persistence failure to the stable 503 response.
 *
 * Controllers call this around evidence writes so a storage outage never turns
 * into a 500 and never lets the protected action continue.
 *
 * @param error - Error raised by the audit writer.
 * @returns The mapped error, or the original error when it is not audit-related.
 */
export function mapAuditError(error: unknown): unknown {
  if (error instanceof AuditUnavailableError) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

/**
 * Runs one audit write and maps its failure to 503.
 *
 * @param action - Audit write to execute.
 */
export async function recordAuditOr503(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw mapAuditError(error);
  }
}

/** Builds one system-scope authentication event. */
function authDraft(
  context: AuditRequestContext,
  overrides: {
    readonly actorId: string | null;
    readonly actorKind: "user" | "system";
    readonly action: "auth.login" | "auth.lockout";
    readonly result: "allow" | "deny";
    readonly details: Readonly<Record<string, string | number>>;
  },
): AuditEventDraft {
  return {
    projectId: null,
    requestId: context.requestId ?? "internal",
    actorId: overrides.actorId,
    actorKind: overrides.actorKind,
    action: overrides.action,
    scopeType: "system",
    scopeId: null,
    objectType: null,
    objectId: null,
    result: overrides.result,
    sourceIp: context.sourceIp ?? null,
    userAgent: context.userAgent ?? null,
    details: overrides.details,
  };
}

/**
 * Records one failed local login and, when it created a lock, one lockout event.
 *
 * @param audit - Audit service.
 * @param result - Failed login result.
 * @param context - Request metadata.
 * @param client - Browser or CLI marker.
 */
export async function recordLocalLoginFailure(
  audit: AuditService,
  result: LocalLoginResult,
  context: AuditRequestContext,
  client: "browser" | "cli",
): Promise<void> {
  if (result.ok) {
    return;
  }
  const actorId = result.principalId ?? null;
  const actorKind = actorId === null ? "system" : "user";
  await audit.record(
    authDraft(context, {
      actorId,
      actorKind,
      action: "auth.login",
      result: "deny",
      details: { method: "local", client, reason: result.reason },
    }),
  );
  if (result.lockedUntil !== undefined) {
    await audit.record(
      authDraft(context, {
        actorId,
        actorKind,
        action: "auth.lockout",
        result: "deny",
        details: { method: "local", client, lockSeconds: 900 },
      }),
    );
  }
}

/**
 * Records one successful authentication event.
 *
 * @param audit - Audit service.
 * @param principalId - Resolved principal.
 * @param context - Request metadata.
 * @param method - Authentication method.
 * @param client - Browser or CLI marker.
 */
export async function recordLoginAllow(
  audit: AuditService,
  principalId: string,
  context: AuditRequestContext,
  method: "local" | "oidc",
  client: "browser" | "cli",
  tx?: import("./types.js").AuditQueryExecutor,
): Promise<void> {
  await audit.record(
    authDraft(context, {
      actorId: principalId,
      actorKind: "user",
      action: "auth.login",
      result: "allow",
      details: { method, client },
    }),
    tx,
  );
}

/**
 * Records one failed OIDC callback attempt.
 *
 * @param audit - Audit service.
 * @param context - Request metadata.
 * @param reason - Stable internal reason.
 */
export async function recordOidcFailure(
  audit: AuditService,
  context: AuditRequestContext,
  reason: "oidc_flow" | "oidc_unavailable" | "access_denied" | "link_collision",
): Promise<void> {
  await audit.record(
    authDraft(context, {
      actorId: null,
      actorKind: "system",
      action: "auth.login",
      result: "deny",
      details: { method: "oidc", client: "browser", reason },
    }),
  );
}
