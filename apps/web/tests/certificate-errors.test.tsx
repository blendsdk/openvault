import { fireEvent, screen } from "@testing-library/react";
import { ApiError } from "blendsdk/api-client";
import { describe, expect, it } from "vitest";
import { certificateErrorText } from "../src/components/certificate-errors.js";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function apiError(statusCode: number, code: string, message: string): ApiError {
  return new ApiError(message, { statusCode, code, operationId: "test" });
}

function renderDetail(vault: FakeVault) {
  return renderProjectPage(<CertificateDetailPage />, {
    vault,
    path: "/projects/payments/certificates/api-tls",
    route: "/projects/:project/certificates/:name",
  });
}

async function deleteAndConfirm(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
}

describe("certificate error mapping", () => {
  it("should map every documented certificate error code", () => {
    expect(certificateErrorText(apiError(409, "certificate_version_conflict", "conflict"))).toBe(
      "This certificate changed. Reload the page and try again.",
    );
    expect(certificateErrorText(apiError(409, "purge_protection_locked", "locked"))).toBe(
      "Purge protection is on and cannot be turned off.",
    );
    expect(certificateErrorText(apiError(409, "certificate_retention_active", "retained"))).toBe(
      "The retention period has not ended. Purge is available after the displayed date.",
    );
    expect(certificateErrorText(apiError(404, "certificate_not_found", "missing"))).toBe(
      "Certificate not found.",
    );
    expect(certificateErrorText(apiError(403, "access_denied", "denied"))).toBe(
      "You do not have permission for this action.",
    );
    expect(certificateErrorText(apiError(422, "validation_error", "invalid"))).toBe(
      "The form values are not valid.",
    );
    expect(certificateErrorText(apiError(500, "internal_error", "broken"))).toBeUndefined();
  });

  it("should render the access-denied message for a forbidden action", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    vault.failCertificate = {
      status: 403,
      code: "access_denied",
      message: "Access denied",
    };
    await deleteAndConfirm();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission for this action.");
  });

  it("should render the version-conflict message", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    vault.failCertificate = {
      status: 409,
      code: "certificate_version_conflict",
      message: "conflict",
    };
    await deleteAndConfirm();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This certificate changed. Reload the page and try again.");
  });

  it("should render the retention message and never a raw stack, SQL, or path", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    vault.failCertificate = {
      status: 409,
      code: "certificate_retention_active",
      message: "SELECT * FROM certificates at /srv/openvault/src/certificates.ts",
    };
    await deleteAndConfirm();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The retention period has not ended. Purge is available after the displayed date.",
    );
    expect(alert).not.toHaveTextContent("SELECT");
    expect(alert).not.toHaveTextContent("/srv/");
    expect(alert).not.toHaveTextContent("at ");
  });

  it("should show a safe fallback for an unknown failure", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    vault.failCertificate = {
      status: 500,
      code: "internal_error",
      message: "Internal Server Error",
    };
    await deleteAndConfirm();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Internal Server Error");
    expect(alert).not.toHaveTextContent("stack");
  });
});
