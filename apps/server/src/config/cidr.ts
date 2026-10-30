import { isIP } from "node:net";
import { ConfigError } from "./errors.js";
import type { Cidr } from "./types.js";

const KEY = "OPENVAULT_PROXY_CIDRS";

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const byte = Number(part);
    if (byte > 255) {
      return undefined;
    }
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(value: string): readonly number[] | undefined {
  if (value.includes("%")) {
    return undefined;
  }
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const ipv4 = parseIpv4(group);
        if (!ipv4) {
          return undefined;
        }
        groups.push(((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0), ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) {
          return undefined;
        }
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };

  const left = parseGroups(halves[0] ?? "");
  const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!left || !right) {
    return undefined;
  }

  let groups: readonly number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) {
      return undefined;
    }
    groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) {
    return undefined;
  }

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push(group >> 8, group & 0xff);
  }
  return bytes;
}

function formatIpv4(bytes: readonly number[]): string {
  return bytes.join(".");
}

function formatIpv6(bytes: readonly number[]): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; start += 1) {
    if (groups[start] !== 0) {
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) {
      end += 1;
    }
    const length = end - start;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
    start = end - 1;
  }

  const render = (values: readonly number[]): string =>
    values.map((value) => value.toString(16)).join(":");

  if (bestLength >= 2) {
    const before = render(groups.slice(0, bestStart));
    const after = render(groups.slice(bestStart + bestLength));
    return `${before}::${after}`;
  }
  return render(groups);
}

function applyPrefix(bytes: readonly number[], prefix: number): readonly number[] {
  return bytes.map((byte, index) => {
    const remaining = prefix - index * 8;
    if (remaining >= 8) {
      return byte;
    }
    if (remaining <= 0) {
      return 0;
    }
    return byte & (0xff << (8 - remaining));
  });
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Parses and normalises a comma-separated CIDR list.
 *
 * Each entry must be a canonical network address: a prefix with host bits set
 * (for example `172.30.0.9/24`) is rejected instead of being silently masked.
 *
 * @param raw - Comma-separated IPv4 and IPv6 CIDRs.
 * @returns A frozen list of validated networks.
 * @throws {ConfigError} When an entry is empty, malformed, or non-canonical.
 */
export function parseCidrList(raw: string): readonly Cidr[] {
  const entries = raw.split(",");
  if (entries.length === 0) {
    throw new ConfigError(KEY, "must contain at least one CIDR");
  }

  const result: Cidr[] = [];
  for (const entry of entries) {
    const value = entry.trim();
    if (value.length === 0) {
      throw new ConfigError(KEY, "must not contain an empty CIDR");
    }

    const parts = value.split("/");
    if (parts.length !== 2) {
      throw new ConfigError(KEY, "must use the address/prefix form");
    }
    const address = parts[0] ?? "";
    const prefixText = parts[1] ?? "";
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new ConfigError(KEY, "contains an invalid IP address");
    }
    if (!/^\d{1,3}$/.test(prefixText)) {
      throw new ConfigError(KEY, "contains an invalid prefix length");
    }

    const prefix = Number(prefixText);
    const maximum = family === 4 ? 32 : 128;
    if (prefix > maximum) {
      throw new ConfigError(KEY, "contains a prefix longer than the address family allows");
    }

    const bytes = family === 4 ? parseIpv4(address) : parseIpv6(address);
    if (!bytes) {
      throw new ConfigError(KEY, "contains an invalid IP address");
    }
    const network = applyPrefix(bytes, prefix);
    if (!sameBytes(network, bytes)) {
      throw new ConfigError(KEY, "must use a network address without host bits");
    }

    result.push({
      address: family === 4 ? formatIpv4(network) : formatIpv6(network),
      prefix,
      family: family === 4 ? "ipv4" : "ipv6",
    });
  }

  return Object.freeze(result);
}

/**
 * Renders a validated CIDR in `address/prefix` form for support output.
 *
 * @param cidr - Validated network.
 * @returns Text form of the network.
 */
export function formatCidr(cidr: Cidr): string {
  return `${cidr.address}/${cidr.prefix}`;
}
