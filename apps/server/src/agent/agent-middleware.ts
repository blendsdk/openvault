import { ApiError } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { listenerOf, normalizeRequestPath } from "../transport/scope.js";
import type { AgentAuthenticator } from "./agent-authenticator.js";
import type { AgentProjectResolver } from "./project-resolver.js";
import type { AgentAuthContext } from "./types.js";

const AGENT_JOIN_PATH = "/v1/agent/join";
const DATA_PREFIX = "/v1/data/";

/**
 * Returns the authenticated agent context or raises the stable 401 error.
 *
 * @param req - Express request.
 * @returns The agent context.
 * @throws {ApiError} 401 when no live agent certificate is attached.
 */
export function requireAgent(req: Request): AgentAuthContext {
  if (req.agent === undefined) {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return req.agent;
}

/**
 * Installs the default-deny agent authentication boundary.
 *
 * Only `POST /v1/agent/join` is unauthenticated. Every other agent-listener
 * route, including `/health`, requires a live workload certificate. Data paths
 * additionally require the path project to equal the certificate's project.
 * Database or cache failures fail closed with a 503.
 *
 * @param authenticator - Request authenticator.
 * @param resolver - Active-project resolver for data paths.
 * @returns Express middleware.
 */
export function agentAuthMiddleware(
  authenticator: AgentAuthenticator,
  resolver: AgentProjectResolver,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (listenerOf(req) !== "agent") {
        next();
        return;
      }

      const path = normalizeRequestPath(req.originalUrl || req.url);
      if (req.method === "POST" && path === AGENT_JOIN_PATH) {
        next();
        return;
      }

      const context = await authenticator.authenticate(req);
      if (context === undefined) {
        throw new ApiError(401, "authentication_required", "Authentication required");
      }
      req.agent = context;

      if (path.startsWith(DATA_PREFIX)) {
        const projectName = path.slice(DATA_PREFIX.length).split("/")[0] ?? "";
        const project = await resolver.resolveActiveByName(projectName);
        if (project === undefined || project.id !== context.projectId) {
          throw new ApiError(403, "access_denied", "Access denied");
        }
      }

      next();
    } catch (error) {
      if (error instanceof ApiError) {
        next(error);
        return;
      }
      next(new ApiError(503, "service_unavailable", "Service unavailable"));
    }
  };
}
