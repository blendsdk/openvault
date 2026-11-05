import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { normalizePeerAddress } from "../transport/proxy.js";

const WINDOW_MS = 60_000;
const JOIN_LIMIT = 10;
const RENEW_PRINCIPAL_LIMIT = 10;
const RENEW_IP_LIMIT = 60;
const CONSUMER_STATE_LIMIT = 60;

/** The three per-application agent limiter instances. */
export interface AgentRateLimitService {
  /** Ten joins per minute per source address. */
  readonly joinIp: RequestHandler;
  /** Ten renewals per minute per service principal. */
  readonly renewPrincipal: RequestHandler;
  /** Sixty renewals per minute per source address. */
  readonly renewIp: RequestHandler;
  /** Sixty consumer heartbeats per minute per principal. */
  readonly consumerState: RequestHandler;
}

/** Uses the TCP peer address, never a forwarded header. */
function peerKey(req: Request): string {
  return `ip:${normalizePeerAddress(req.socket.remoteAddress) ?? "unknown"}`;
}

/** Test-only overrides for limiter thresholds. */
export interface AgentRateLimitOptions {
  /** Joins per minute per source address. */
  readonly joinLimit?: number;
  /** Renewals per minute per principal. */
  readonly renewPrincipalLimit?: number;
  /** Renewals per minute per source address. */
  readonly renewIpLimit?: number;
  /** Consumer heartbeats per minute per principal. */
  readonly consumerStateLimit?: number;
}

/**
 * Creates one set of agent limiter instances for an application.
 *
 * @param options - Test-only threshold overrides; production leaves this empty.
 * @returns The shared limiter service.
 */
export function createAgentRateLimitService(
  options: AgentRateLimitOptions = {},
): AgentRateLimitService {
  return {
    joinIp: rateLimitMiddleware({
      maxRequests: options.joinLimit ?? JOIN_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: peerKey,
    }),
    renewPrincipal: rateLimitMiddleware({
      maxRequests: options.renewPrincipalLimit ?? RENEW_PRINCIPAL_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: (req) => `principal:${req.agent?.principalId ?? "unknown"}`,
    }),
    renewIp: rateLimitMiddleware({
      maxRequests: options.renewIpLimit ?? RENEW_IP_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: peerKey,
    }),
    consumerState: rateLimitMiddleware({
      maxRequests: options.consumerStateLimit ?? CONSUMER_STATE_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: (req) => `principal:${req.agent?.principalId ?? "unknown"}`,
    }),
  };
}

type AgentLimiterName = keyof AgentRateLimitService;

function resolveLimiter(name: AgentLimiterName): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<AgentRateLimitService>("agentRateLimits")
      .then((limits) => limits[name](req, res, next))
      .catch(next);
  };
}

/**
 * Applies the per-address join limit before CSR or token work.
 *
 * @returns An Express middleware.
 */
export function joinIpLimit(): RequestHandler {
  return resolveLimiter("joinIp");
}

/**
 * Applies the per-principal renewal limit after agent authentication.
 *
 * @returns An Express middleware.
 */
export function renewPrincipalLimit(): RequestHandler {
  return resolveLimiter("renewPrincipal");
}

/**
 * Applies the per-address renewal limit after agent authentication.
 *
 * @returns An Express middleware.
 */
export function renewIpLimit(): RequestHandler {
  return resolveLimiter("renewIp");
}

/**
 * Applies the per-principal consumer heartbeat limit.
 *
 * @returns An Express middleware.
 */
export function consumerStateLimit(): RequestHandler {
  return resolveLimiter("consumerState");
}
