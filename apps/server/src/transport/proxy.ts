import { BlockList, isIP } from "node:net";
import type { Cidr } from "../config/index.js";

/** Loopback networks used for container health checks. */
export const LOOPBACK_CIDRS: readonly Cidr[] = Object.freeze([
  { address: "127.0.0.0", prefix: 8, family: "ipv4" },
  { address: "::1", prefix: 128, family: "ipv6" },
]);

/** The broad proxy default that gets a production warning. */
export const BROAD_PROXY_DEFAULT: Cidr = Object.freeze({
  address: "172.16.0.0",
  prefix: 12,
  family: "ipv4",
});

/**
 * Normalises a socket peer address for CIDR matching.
 *
 * IPv4-mapped IPv6 addresses become IPv4, zone identifiers are removed, and
 * invalid values return `undefined` instead of throwing.
 */
export function normalizePeerAddress(address: string | undefined): string | undefined {
  if (address === undefined) {
    return undefined;
  }
  let value = address.trim();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) {
    value = value.slice(0, zoneIndex);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  if (value.toLowerCase().startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) {
      return mapped;
    }
  }
  return isIP(value) === 0 ? undefined : value;
}

/**
 * Matches peer addresses against validated IPv4 and IPv6 networks.
 *
 * Malformed or mixed-family values return `false` rather than throwing, so a
 * request from an unexpected address fails closed.
 */
export class CidrMatcher {
  readonly #blockList = new BlockList();

  public constructor(cidrs: readonly Cidr[]) {
    for (const cidr of cidrs) {
      this.#blockList.addSubnet(cidr.address, cidr.prefix, cidr.family);
    }
  }

  /** Reports whether the peer address is inside one of the configured networks. */
  public contains(address: string | undefined): boolean {
    const normalized = normalizePeerAddress(address);
    if (normalized === undefined) {
      return false;
    }
    const family = isIP(normalized);
    if (family !== 4 && family !== 6) {
      return false;
    }
    try {
      return this.#blockList.check(normalized, family === 4 ? "ipv4" : "ipv6");
    } catch {
      return false;
    }
  }
}

/**
 * Builds the Express `trust proxy` predicate.
 *
 * Only a socket peer inside the configured CIDRs may set forwarded headers.
 */
export function createTrustProxy(matcher: CidrMatcher): (remoteAddress: string) => boolean {
  return (remoteAddress: string) => matcher.contains(remoteAddress);
}

/** Reports whether a peer is loopback. */
export function isLoopbackPeer(address: string | undefined): boolean {
  return new CidrMatcher(LOOPBACK_CIDRS).contains(address);
}

/** Reports whether the configured list is exactly the broad default. */
export function usesBroadProxyDefault(cidrs: readonly Cidr[]): boolean {
  return (
    cidrs.length === 1 &&
    cidrs[0]?.address === BROAD_PROXY_DEFAULT.address &&
    cidrs[0]?.prefix === BROAD_PROXY_DEFAULT.prefix &&
    cidrs[0]?.family === BROAD_PROXY_DEFAULT.family
  );
}
