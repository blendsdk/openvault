import { AUDIT_ACTIONS, auditQuerySchema, RBAC_ACTIONS } from "@openvault/api-contract";
import { describe, expect, it } from "vitest";
import { allowedDetailKeys, validateDetails } from "../../src/audit/actions.js";
import { AuditInputError, AuditUnavailableError } from "../../src/audit/errors.js";
import { recordAuditOr503 } from "../../src/audit/http.js";
import {
  OidcAccessDeniedError,
  OidcLinkCollisionError,
  OidcUnavailableError,
} from "../../src/auth/oidc/errors.js";
import { oidcFailureReason } from "../../src/controllers/oidc.js";

describe("audit security contracts", () => {
  it("should include every RBAC action in the audit catalog and query schema", () => {
    const catalog = new Set<string>(AUDIT_ACTIONS);
    for (const action of RBAC_ACTIONS) {
      expect(catalog.has(action)).toBe(true);
      expect(auditQuerySchema.safeParse({ action }).success).toBe(true);
    }
  });

  it("should reject secret-bearing details keys", () => {
    for (const key of ["privateKey", "csr", "password", "token", "cookie"]) {
      expect(() => validateDetails("auth.login", { [key]: "sentinel" })).toThrow(AuditInputError);
    }
  });

  it("should reject a nested object outside the filters field", () => {
    expect(() => validateDetails("auth.login", { method: { nested: true } })).toThrow(
      AuditInputError,
    );
  });

  it("should expose only the documented policy detail keys", () => {
    expect([...allowedDetailKeys("identity.create")].sort()).toEqual([
      "denialCount",
      "policyVersion",
      "reason",
      "version",
    ]);
    expect(allowedDetailKeys("kek.rotate").has("kekId")).toBe(true);
  });

  it("should map OIDC failures to distinct audit reasons", () => {
    expect(oidcFailureReason(new OidcUnavailableError())).toBe("oidc_unavailable");
    expect(oidcFailureReason(new OidcAccessDeniedError())).toBe("access_denied");
    expect(oidcFailureReason(new OidcLinkCollisionError())).toBe("link_collision");
    expect(oidcFailureReason(new Error("other"))).toBe("oidc_flow");
  });

  it("should map an audit storage failure to 503 and pass others through", async () => {
    await expect(
      recordAuditOr503(async () => {
        throw new AuditUnavailableError();
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "service_unavailable" });
    await expect(
      recordAuditOr503(async () => {
        throw new Error("storage down");
      }),
    ).rejects.toThrow("storage down");
  });
});
