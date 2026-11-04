import type { Request } from "express";
import type { AuditRequestContext } from "./types.js";

/**
 * Builds request metadata for audit events.
 *
 * The request id falls back to an internal value because every stored row
 * requires a non-empty correlation id.
 *
 * @param req - Express request.
 * @returns Context accepted by the audit service.
 */
export function auditRequestContext(req: Request): AuditRequestContext {
  return {
    requestId: req.id === undefined ? "internal" : req.id,
    ...(req.ip === undefined ? {} : { sourceIp: req.ip }),
    ...(typeof req.headers["user-agent"] === "string"
      ? { userAgent: req.headers["user-agent"] }
      : {}),
  };
}
