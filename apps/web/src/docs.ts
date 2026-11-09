/**
 * Public documentation site for this repository.
 *
 * The VitePress build publishes under this base on GitHub Pages. The value is
 * intentionally absolute: the documentation is a separate deployment from a
 * self-hosted vault, so resolving it against the current browser origin would
 * send operators to a path the vault server does not serve.
 */
export const DOCS_BASE_URL = "https://blendsdk.github.io/openvault";

/**
 * Returns the documentation path for a UI route.
 *
 * The top-bar docs link should land on the guide that explains the screen the
 * operator is looking at, not always on the documentation home page. Unknown
 * routes fall back to the docs home rather than guessing.
 *
 * @param pathname - Current client-side route, without query or hash.
 * @returns A path below {@link DOCS_BASE_URL}, including an anchor when useful.
 *
 * @example
 * ```ts
 * docsPathForRoute("/projects/payments/secrets");
 * // "/guide/secrets#secret-write-and-read"
 * ```
 */
export function docsPathForRoute(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return "/guide/secrets#projects";
  }
  if (pathname === "/change-password") {
    return "/guide/authentication#browser-sessions";
  }
  if (!pathname.startsWith("/projects/")) {
    return "/";
  }

  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const section = segments[2];
  switch (section) {
    case undefined:
      return "/guide/web-ui#daily-flows";
    case "secrets":
      return segments.length > 3
        ? "/guide/web-ui#reveal-and-clipboard"
        : "/guide/secrets#secret-write-and-read";
    case "rotation":
      return "/guide/rotation";
    case "certificates":
      return segments.length > 3 ? "/guide/certificates#read-and-renew" : "/guide/certificates";
    case "identities":
      return "/guide/agent";
    case "permissions":
      return "/guide/rbac";
    case "audit":
      return "/guide/audit";
    case "consumers":
      return "/guide/agent#consumer-metadata";
    default:
      return "/guide/web-ui#daily-flows";
  }
}

/**
 * Returns the absolute documentation URL for a UI route.
 *
 * @param pathname - Current client-side route, without query or hash.
 * @returns The full docs URL opened by the top-bar link.
 */
export function docsUrlForRoute(pathname: string): string {
  return `${DOCS_BASE_URL}${docsPathForRoute(pathname)}`;
}
