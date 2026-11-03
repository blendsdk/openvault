import { describe, expect, it } from "vitest";
import {
  ACTION_DEFINITIONS,
  isControlPlaneAction,
  RBAC_ACTIONS,
  type RbacAction,
} from "../../src/rbac/actions.js";
import {
  RBAC_ROLES,
  type RbacRole,
  ROLE_DEFINITIONS,
  roleEligibleAt,
} from "../../src/rbac/roles.js";

const ALL_ACTIONS: readonly RbacAction[] = [
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "identity.create",
  "identity.read",
  "identity.revoke",
  "identity.join_token",
  "assignment.read",
  "assignment.write",
  "audit.read",
  "kek.rotate",
  "secret.list",
  "secret.read",
  "secret.write",
  "secret.delete",
  "secret.recover",
  "secret.purge",
  "certificate.list",
  "certificate.read",
  "certificate.read_private",
  "certificate.write",
  "certificate.delete",
  "certificate.recover",
  "certificate.purge",
];

const EXPECTED_ACTIONS: Record<RbacRole, readonly RbacAction[]> = {
  "org.admin": ALL_ACTIONS,
  "project.admin": [
    "project.read",
    "project.update",
    "identity.create",
    "identity.read",
    "identity.revoke",
    "identity.join_token",
    "assignment.read",
    "assignment.write",
    "secret.list",
    "secret.read",
    "secret.write",
    "secret.delete",
    "secret.recover",
    "secret.purge",
    "certificate.list",
    "certificate.read",
    "certificate.read_private",
    "certificate.write",
    "certificate.delete",
    "certificate.recover",
    "certificate.purge",
  ],
  "secrets.manager": [
    "secret.list",
    "secret.read",
    "secret.write",
    "secret.delete",
    "secret.recover",
    "secret.purge",
  ],
  "secrets.officer": [
    "secret.list",
    "secret.read",
    "secret.write",
    "secret.delete",
    "secret.recover",
  ],
  "secrets.reader": ["secret.list", "secret.read"],
  "certificates.officer": [
    "certificate.list",
    "certificate.read",
    "certificate.read_private",
    "certificate.write",
    "certificate.delete",
    "certificate.recover",
  ],
  "certificates.reader": ["certificate.list", "certificate.read"],
  auditor: [
    "project.read",
    "identity.read",
    "assignment.read",
    "audit.read",
    "secret.list",
    "certificate.list",
  ],
  reader: ["project.read", "secret.list", "certificate.list"],
};

const EXPECTED_DESCRIPTIONS: Record<RbacAction, string> = {
  "project.create": "Create a project",
  "project.read": "Read project metadata",
  "project.update": "Rename or change project settings",
  "project.delete": "Soft-delete a project",
  "identity.create": "Create a service identity",
  "identity.read": "Read identity metadata",
  "identity.revoke": "Disable an identity and revoke its credentials",
  "identity.join_token": "Issue a join token",
  "assignment.read": "Read assignments and access explanations",
  "assignment.write": "Grant or revoke roles",
  "audit.read": "Read or export audit events",
  "kek.rotate": "Start KEK rotation",
  "secret.list": "List secret metadata and consumer summaries",
  "secret.read": "Read a secret value or version",
  "secret.write": "Create, update, or add a version",
  "secret.delete": "Soft-delete a secret",
  "secret.recover": "Recover a soft-deleted secret",
  "secret.purge": "Permanently delete a secret",
  "certificate.list": "List certificate metadata",
  "certificate.read": "Read a certificate chain",
  "certificate.read_private": "Read a certificate private key",
  "certificate.write": "Import, generate, or update a certificate",
  "certificate.delete": "Soft-delete a certificate",
  "certificate.recover": "Recover a soft-deleted certificate",
  "certificate.purge": "Permanently delete a certificate",
};

const EXPECTED_SCOPES: Record<RbacRole, readonly ("org" | "project" | "object")[]> = {
  "org.admin": ["org"],
  "project.admin": ["org", "project"],
  "secrets.manager": ["org", "project"],
  "secrets.officer": ["org", "project"],
  "secrets.reader": ["org", "project", "object"],
  "certificates.officer": ["org", "project"],
  "certificates.reader": ["org", "project", "object"],
  auditor: ["org", "project"],
  reader: ["org", "project"],
};

describe("action catalog", () => {
  it("should expose exactly the 25 published actions in order", () => {
    expect(RBAC_ACTIONS).toEqual(ALL_ACTIONS);
    expect(new Set(RBAC_ACTIONS).size).toBe(25);
    expect(ACTION_DEFINITIONS.size).toBe(25);
  });

  it("should mark the first twelve actions as control plane and the rest as data plane", () => {
    for (const [index, action] of RBAC_ACTIONS.entries()) {
      const definition = ACTION_DEFINITIONS.get(action);
      expect(definition).toBeDefined();
      expect(definition?.description).toBe(EXPECTED_DESCRIPTIONS[action]);
      expect(definition?.plane).toBe(index < 12 ? "control" : "data");
      expect(isControlPlaneAction(action)).toBe(index < 12);
    }
  });
});

describe("role matrix", () => {
  it("should expose exactly the nine published roles", () => {
    expect(RBAC_ROLES).toEqual([
      "org.admin",
      "project.admin",
      "secrets.manager",
      "secrets.officer",
      "secrets.reader",
      "certificates.officer",
      "certificates.reader",
      "auditor",
      "reader",
    ]);
    expect(ROLE_DEFINITIONS.size).toBe(9);
  });

  it("should match the published action matrix for every role", () => {
    for (const role of RBAC_ROLES) {
      const definition = ROLE_DEFINITIONS.get(role);
      expect(definition).toBeDefined();
      expect(new Set(definition?.actions)).toEqual(new Set(EXPECTED_ACTIONS[role]));
    }
  });

  it("should match the published scope eligibility for every role", () => {
    for (const role of RBAC_ROLES) {
      const definition = ROLE_DEFINITIONS.get(role);
      expect(new Set(definition?.scopes)).toEqual(new Set(EXPECTED_SCOPES[role]));
      for (const scope of ["org", "project", "object"] as const) {
        expect(roleEligibleAt(role, scope), `${role} at ${scope}`).toBe(
          EXPECTED_SCOPES[role]?.includes(scope) ?? false,
        );
      }
    }
  });

  it("should keep object scope limited to the two reader roles", () => {
    for (const role of RBAC_ROLES) {
      expect(roleEligibleAt(role, "object")).toBe(
        role === "secrets.reader" || role === "certificates.reader",
      );
    }
  });
});
