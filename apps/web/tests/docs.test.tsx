import { describe, expect, it } from "vitest";
import { DOCS_BASE_URL, docsPathForRoute, docsUrlForRoute } from "../src/docs.js";

describe("documentation link", () => {
  it("should route the project list to the project guide", () => {
    expect(docsPathForRoute("/")).toBe("/guide/secrets#projects");
    expect(docsUrlForRoute("/")).toBe(`${DOCS_BASE_URL}/guide/secrets#projects`);
  });

  it("should route the project overview to the daily flows", () => {
    expect(docsPathForRoute("/projects/payments")).toBe("/guide/web-ui#daily-flows");
  });

  it("should route the secret list and detail to their guide sections", () => {
    expect(docsPathForRoute("/projects/payments/secrets")).toBe(
      "/guide/secrets#secret-write-and-read",
    );
    expect(docsPathForRoute("/projects/payments/secrets/stripe-api-key")).toBe(
      "/guide/web-ui#reveal-and-clipboard",
    );
  });

  it("should route the project sections to their matching guides", () => {
    expect(docsPathForRoute("/projects/payments/identities")).toBe("/guide/agent");
    expect(docsPathForRoute("/projects/payments/permissions")).toBe("/guide/rbac");
    expect(docsPathForRoute("/projects/payments/audit")).toBe("/guide/audit");
    expect(docsPathForRoute("/projects/payments/consumers")).toBe("/guide/agent#consumer-metadata");
  });

  it("should handle trailing slashes and unknown routes", () => {
    expect(docsPathForRoute("/projects/payments/secrets/")).toBe(
      "/guide/secrets#secret-write-and-read",
    );
    expect(docsPathForRoute("/not-a-route")).toBe("/");
    expect(docsPathForRoute("/change-password")).toBe("/guide/authentication#browser-sessions");
  });
});
