import { createTransportError } from "blendsdk/api-client";
import { describe, expect, it } from "vitest";
import { asCliError, RefreshRejectedError } from "../src/errors.js";

describe("CLI error mapping", () => {
  it("should map a wrapped refresh rejection to authentication exit 3", () => {
    const error = asCliError(createTransportError(new RefreshRejectedError(), "getCliMe"));
    expect(error.code).toBe("authentication_required");
    expect(error.exitCode).toBe(3);
  });

  it("should map a wrapped certificate failure to the TLS code", () => {
    const error = asCliError(
      createTransportError(new Error("unable to verify the first certificate"), "listProjects"),
    );
    expect(error.code).toBe("tls_verification_failed");
    expect(error.exitCode).toBe(1);
  });

  it("should map a wrapped timeout and oversized response", () => {
    expect(asCliError(createTransportError(new Error("request_timeout"), "op")).code).toBe(
      "request_timeout",
    );
    expect(asCliError(createTransportError(new Error("response_too_large"), "op")).code).toBe(
      "response_too_large",
    );
  });

  it("should preserve a bootstrap error code and choose the usage exit code", () => {
    const recovery = new Error("restore the keyring from backup");
    recovery.name = "InitError";
    Object.defineProperty(recovery, "code", { value: "init_recovery_required" });
    const mapped = asCliError(recovery);
    expect(mapped.code).toBe("init_recovery_required");
    expect(mapped.exitCode).toBe(1);

    const configuration = new Error("bad URL");
    configuration.name = "InitError";
    Object.defineProperty(configuration, "code", { value: "init_configuration" });
    const usage = asCliError(configuration);
    expect(usage.code).toBe("init_configuration");
    expect(usage.exitCode).toBe(2);
  });
});
