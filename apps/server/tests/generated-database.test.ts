import { describe, expect, it } from "vitest";
import { eSecrets, eSecretVersions, type Secrets } from "../src/database/index.js";

describe("generated database artifacts", () => {
  it("should expose table and column constants for query code", () => {
    expect(eSecrets.$TABLE).toBe("secrets");
    expect(eSecrets.PROJECT_ID).toBe("project_id");
    expect(eSecretVersions.$TABLE).toBe("secret_versions");
    expect(eSecretVersions.CIPHERTEXT).toBe("ciphertext");
  });

  it("should expose generated row types", () => {
    const name: Secrets["name"] = "database-password";
    expect(name).toBe("database-password");
  });
});
